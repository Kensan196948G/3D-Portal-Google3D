"""遅れの予兆：日次の記録・前週比の判定・メールでの通知。

- 日次の記録は、毎朝の定時処理（tools/daily_job.py）がサーバの上で、DB の台帳・実績を画面の計算（ワールドモデル）に渡して
  正式な予測（初期計画の編成＋実績で較正した実効率＝ s.base。What-if は含まない）を求め、DB へ直接 1現場1日1行で保存する。
  画面・API からは書き込めない（書き込み口もログイン用の専用アカウントも作らない）
- 予兆：最新の記録と、それより compareDays 日以上前でいちばん新しい記録を比べ、遅れが deltaDays 日以上ふえた現場、
  または遅れ 14 日以内から 14 日超へ悪化した現場。過去の記録はさかのぼって作らない（記録が 7 日分たまるまでは判定しない）
- メールは設定が「有効」で、SMTP の設定・宛先・STARTTLS・パスワードがそろい、今日の記録があり、予兆が 1 件以上あるときだけ、
  1 日 1 回まで送る（CI では送らない）。desknet's NEO は API の仕様が確認できるまで文面の確認だけ
"""
import os
import re
import smtplib
import ssl
from datetime import date, timedelta
from email.message import EmailMessage

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .db import connect
from .security import require, audit

router = APIRouter()
WARNING_DEFAULT = {'deltaDays': 7, 'compareDays': 7}
LATE = 14
TEMPLATE_KEYS = ('date', 'total', 'late', 'warn', 'lines', 'rising', 'rising_lines')


def fill(template: str, vals: dict) -> str:
    """文面の型の差し込み（決まった名前だけ。それ以外の { } はそのまま残す）。"""
    return re.sub(r'\{(' + '|'.join(TEMPLATE_KEYS) + r')\}', lambda m: str(vals.get(m.group(1), '')), template)


class SnapItem(BaseModel):
    site_key: str = Field(pattern=r'^[a-z0-9_]{1,64}$')
    delay_days: int = Field(ge=-3650, le=3650)
    forecast_end: date
    actual_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    plan_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    eta: float | None = Field(default=None, ge=0, le=10, allow_inf_nan=False)


def save_snapshots(items: list[dict], today: date | None = None) -> int:
    """定時処理の計算結果を保存する（同じ日に再実行したら上書き）。値の範囲は SnapItem で確かめる。"""
    rows = [SnapItem(**i) for i in items]
    if not 1 <= len(rows) <= 1000:
        raise ValueError('件数が正しくありません')
    today = today or date.today()
    with connect() as c:
        keys = {r['key'] for r in c.execute('SELECT key FROM portal.sites')}
        bad = sorted({i.site_key for i in rows} - keys)
        if bad:
            raise ValueError(f'台帳に無い現場：{bad}')
        for i in rows:
            c.execute("""INSERT INTO portal.delay_snapshots(site_key, snap_date, delay_days, forecast_end, actual_pct, plan_pct, eta)
                         VALUES (%s,%s,%s,%s,%s,%s,%s)
                         ON CONFLICT (site_key, snap_date) DO UPDATE SET delay_days=EXCLUDED.delay_days, forecast_end=EXCLUDED.forecast_end,
                           actual_pct=EXCLUDED.actual_pct, plan_pct=EXCLUDED.plan_pct, eta=EXCLUDED.eta, created_at=now()""",
                      (i.site_key, today, i.delay_days, i.forecast_end, i.actual_pct, i.plan_pct, i.eta))
        audit(c, None, 'snapshot', {'n': len(rows), 'date': today.isoformat(), 'by': 'daily_job'})
    return len(rows)


def warning_rule(c) -> dict:
    r = c.execute("SELECT value FROM portal.settings WHERE key='warning'").fetchone()
    v = {**WARNING_DEFAULT, **(r['value'] if r else {})}
    return {'deltaDays': min(max(int(v['deltaDays']), 1), 90), 'compareDays': min(max(int(v['compareDays']), 1), 60)}


def trends(c, rule: dict | None = None) -> dict:
    """現場ごとの遅れの推移（最近 120 日）と、前回（compareDays 日以上前）との差。"""
    rule = rule or warning_rule(c)
    last = c.execute('SELECT max(snap_date) AS d FROM portal.delay_snapshots').fetchone()['d']
    out = {'rule': rule, 'latestDate': last.isoformat() if last else None, 'sites': {}}
    if not last:
        return out
    for r in c.execute("""SELECT site_key, snap_date, delay_days, forecast_end FROM portal.delay_snapshots
                          WHERE snap_date >= %s ORDER BY site_key, snap_date""", (last - timedelta(days=120),)):
        out['sites'].setdefault(r['site_key'], []).append(r)
    for k, rows in list(out['sites'].items()):
        cur = rows[-1]
        ref = next((x for x in reversed(rows) if x['snap_date'] <= cur['snap_date'] - timedelta(days=rule['compareDays'])), None)
        delta = cur['delay_days'] - ref['delay_days'] if ref else None
        rising = cur['snap_date'] == last and ref is not None and (delta >= rule['deltaDays'] or (ref['delay_days'] <= LATE < cur['delay_days']))
        out['sites'][k] = {'delay': cur['delay_days'], 'date': cur['snap_date'].isoformat(), 'end': cur['forecast_end'].isoformat(),
                           'refDate': ref['snap_date'].isoformat() if ref else None, 'refDelay': ref['delay_days'] if ref else None,
                           'delta': delta, 'rising': bool(rising), 'series': [[x['snap_date'].isoformat(), x['delay_days']] for x in rows[-60:]]}
    return out


def summary(c) -> dict:
    """通知の差し込み値（最新の日次の記録から。画面を開かずに作れる）。"""
    t = trends(c)
    names = {r['key']: (r['data'].get('name', r['key']), r['data'].get('br', '')) for r in c.execute('SELECT key, data FROM portal.sites')}
    cur = {k: v for k, v in t['sites'].items() if v['date'] == t['latestDate']}
    late = sorted((k for k, v in cur.items() if v['delay'] > LATE), key=lambda k: -cur[k]['delay'])
    warn = sorted((k for k, v in cur.items() if 0 < v['delay'] <= LATE), key=lambda k: -cur[k]['delay'])
    rising = sorted((k for k, v in cur.items() if v['rising']), key=lambda k: -(cur[k]['delta'] or 0))
    nm = lambda k: names.get(k, (k, ''))[0]
    return {'date': (t['latestDate'] or '').replace('-', '/'), 'latestDate': t['latestDate'], 'total': len(cur), 'late': len(late), 'warn': len(warn),
            'rising': len(rising), 'rule': t['rule'],
            'lines': '\n'.join(f"・{nm(k)} 予測 +{cur[k]['delay']}日" for k in late + warn),
            'rising_lines': '\n'.join(f"・{nm(k)} 予測 +{cur[k]['delay']}日（{cur[k]['refDate'].replace('-', '/')} の +{cur[k]['refDelay']}日から {cur[k]['delta']:+d}日）"
                                      for k in rising) or '（なし）'}


@router.get('/api/trends')
def get_trends(req: Request):
    require(req)
    with connect() as c:
        t = trends(c)
    for v in t['sites'].values():
        v.pop('end', None)
    return t


# ---------- メールの送信（定時処理から。画面からは送らない） ----------
def mail_ready(s: dict) -> list[str]:
    """送信に足りないもの（空なら送れる）。"""
    miss = []
    if not s.get('enabled'):
        miss.append('メール通知が無効')
    for f, n in (('smtpHost', 'SMTP サーバ'), ('from', '差出人')):
        if not s.get(f):
            miss.append(f'{n}が未設定')
    if not s.get('to'):
        miss.append('宛先が未設定')
    if not s.get('tls'):
        miss.append('STARTTLS が無効（暗号化しない送信はしない）')
    if s.get('smtpUser') and not os.environ.get('SMTP_PASSWORD'):
        miss.append('SMTP_PASSWORD（server/.env）が未設定')
    return miss


def send_mail(s: dict, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg['Subject'], msg['From'], msg['To'] = subject, s['from'], ', '.join(s['to'])
    msg.set_content(body)
    with smtplib.SMTP(s['smtpHost'], int(s.get('smtpPort') or 587), timeout=30) as m:
        m.ehlo()
        m.starttls(context=ssl.create_default_context())
        m.ehlo()
        if s.get('smtpUser'):
            m.login(s['smtpUser'], os.environ.get('SMTP_PASSWORD', ''))
        m.send_message(msg)


def notify(dry_run: bool = False, today: date | None = None, sender=send_mail) -> dict:
    """予兆があればメールで知らせる（1日1回まで）。戻り値は結果（本文・宛先のアドレスは含めない）。"""
    from .app import DEFAULTS     # 設定の既定値はサーバ本体と共通
    today = today or date.today()
    if os.environ.get('CI'):
        return {'status': 'skipped', 'reason': 'CI では送信しない'}
    with connect() as c:
        row = c.execute("SELECT value FROM portal.settings WHERE key='mail'").fetchone()
        s = {**DEFAULTS['mail'], **(row['value'] if row else {})}
        v = summary(c)
    if v['latestDate'] != today.isoformat():
        return {'status': 'skipped', 'reason': '今日の日次の記録が無い（定時処理の失敗を確認）'}
    if not v['rising']:
        return {'status': 'skipped', 'reason': '予兆なし', 'late': v['late'], 'warn': v['warn']}
    subject, body = fill(s['subject'], v), fill(s['template'], v)
    miss = mail_ready(s)
    if dry_run or miss:
        return {'status': 'dry-run' if dry_run else 'skipped', 'reason': '、'.join(miss) or '確認のみ', 'rising': v['rising'], 'subject': subject, 'body': body}
    with connect() as c:   # 1日1回：先に「送信中」を記録してから送る（失敗した日は同じ日に再送できる）
        claim = c.execute("""INSERT INTO portal.notify_log(channel, sent_on, status, recipients, rising) VALUES ('mail', %s, 'sending', %s, %s)
                             ON CONFLICT (channel, sent_on) DO UPDATE SET status='sending', updated_at=now() WHERE portal.notify_log.status='failed'
                             RETURNING id""", (today, len(s['to']), v['rising'])).fetchone()
    if not claim:
        return {'status': 'skipped', 'reason': '今日は送信済み'}
    try:
        sender(s, subject, body)
        st, detail = 'sent', None
    except Exception as e:     # 失敗の種類だけを残す（秘密情報は含めない）
        st, detail = 'failed', f'{type(e).__name__}: {str(e)[:200]}'
    with connect() as c:
        c.execute('UPDATE portal.notify_log SET status=%s, detail=%s, updated_at=now() WHERE id=%s', (st, detail, claim['id']))
        audit(c, None, 'notify_mail', {'status': st, 'rising': v['rising'], 'recipients': len(s['to'])})
    return {'status': st, 'rising': v['rising'], 'recipients': len(s['to']), **({'error': detail} if detail else {})}
