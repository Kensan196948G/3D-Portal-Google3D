"""現場台帳（DB が正）：画面からの登録・編集・完了と、その履歴。

- 項目の選択肢（工種・支店・土質・発注者区分・海側）は DB の master の ledger（online/data/master.json から seed）に従う。無ければ受け付けない
- 編集は版（version）を確かめる：古い版からの保存は 409（他の人の変更を上書きしない）
- 画面で登録・編集した現場は origin='portal' になり、seed（online/data/sites.json の取り込み）は上書きしない
- 完了・中止は archived_at を入れて一覧から外す（消さない。戻せるのは管理者）
- 工事番号（data.no）は登録のときに一度だけ決める：支店コード-着工年度（4月始まり）-連番。完了・編集で他の現場の番号は変わらない
- 閲覧範囲（支店）は security の check_site・scope_branches に従う。範囲外は 404
"""
import base64
import secrets
import struct
from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .db import connect
from .security import require, require_csrf, audit, client_ip, check_site, scope_branches

router = APIRouter()
SIZE_MIN, SIZE_MAX = 30, 600                        # 施工範囲の辺 m（標高の取得範囲・格子の大きさ（測量は 200 まで）に収まる）
PLACEHOLDER_SRC = '仮の海底（深浅測量の登録まで・一様）'
EDITABLE = ('name', 'br', 'port', 'client', 'ccat', 'kind', 'start', 'soil', 'lon', 'lat', 'w', 'd', 'sea', 'design', 'seabed')


def fiscal_year(start: str) -> int:
    y, m = int(start[:4]), int(start[5:7])
    return y if m >= 4 else y - 1


def next_number(c, br: str, start: str) -> str:
    """次の工事番号。同時に登録しても重ならないよう、トランザクションの間だけ採番の鍵をかける。完了した現場の番号も使わない。"""
    c.execute("SELECT pg_advisory_xact_lock(hashtext('portal.site_no'))")
    prefix = f'{br}-{fiscal_year(start)}-'
    r = c.execute("""SELECT coalesce(max(split_part(data->>'no', '-', 3)::int), 0) AS n FROM portal.sites
                     WHERE data->>'no' LIKE %s""", (prefix + '%',)).fetchone()
    return f"{prefix}{r['n'] + 1:04d}"


def assign_missing_numbers(c) -> int:
    """工事番号の無い現場（seed で増えた現場など）に、台帳の並び順で番号を付ける。"""
    rows = list(c.execute("""SELECT key, data FROM portal.sites WHERE NOT (data ? 'no')
                             ORDER BY (data->>'seq')::int NULLS LAST, key"""))
    for r in rows:
        no = next_number(c, r['data']['br'], r['data']['start'])
        c.execute("UPDATE portal.sites SET data = data || jsonb_build_object('no', %s::text) WHERE key=%s", (no, r['key']))
    return len(rows)


def _half(x: float) -> int:
    """偶数丸め（画面のローダ・numpy の round と同じ）。"""
    return round(x)


def placeholder_survey(w: float, d: float, seabed: float) -> dict:
    """海上工事の仮の海底：施工範囲の格子（画面のローダと同じ刻み）に一様な T.P. 高さ。深浅測量を登録すれば、それと比べられる。"""
    stp = 2 if max(w, d) <= 120 else 4
    nx, nz = _half(w / stp), _half(d / stp)
    n = (nx + 1) * (nz + 1)
    dm = max(-32768, min(32767, round(seabed * 10)))
    return {'nx': nx, 'nz': nz, 'src': PLACEHOLDER_SRC, 'E': base64.b64encode(struct.pack(f'<{n}h', *([dm] * n))).decode(),
            'emin': seabed, 'emax': seabed, 'emed': seabed}


def ledger_enums(c) -> dict:
    r = c.execute("SELECT data->'ledger' AS l FROM portal.master WHERE key='master'").fetchone()
    if not r or not r['l']:
        raise HTTPException(503, '台帳の選択肢（master の ledger）がありません。python3 -m server.manage seed を実行してください')
    return r['l']


# ---------- 契約（正式工事名・発注機関・工期・受注区分・JV・出典・確認状態） ----------
ROLES_JV = ('単独', 'JV代表', 'JVサブ', 'JV構成員（役割未確認）')
SOURCE_KINDS = ('契約書', '変更契約書', 'JV協定書', '公表資料', '社内の受注伝票', 'その他')
VERIFY_FIELDS = ('title', 'place', 'agency', 'agency_no', 'award_date', 'contract_date', 'period', 'changes', 'role', 'jv')


class ChangeIn(BaseModel):          # 変更契約（工期の変更）
    date: date
    period_end: date
    period_start: date | None = None
    note: str | None = Field(default=None, max_length=200)


class SourceIn(BaseModel):          # 出典（根拠の資料）
    kind: str
    title: str = Field(min_length=1, max_length=120)
    url: str | None = Field(default=None, max_length=500)
    checked_on: date | None = None


class ContractIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)          # 正式工事名（契約書の原文）
    place: str | None = Field(default=None, max_length=200)          # 工事場所（契約書・公表資料の記載のまま）
    agency: str | None = Field(default=None, max_length=120)         # 発注機関（地方整備局・事務所・自治体など）
    agency_no: str | None = Field(default=None, max_length=60)       # 案件番号（発注機関の番号・調達案件番号）
    award_date: date | None = None                                   # 落札決定日
    contract_date: date | None = None                                # 契約締結日（受注日）
    period_start: date | None = None                                 # 当初の工期
    period_end: date | None = None
    changes: list[ChangeIn] = Field(default_factory=list, max_length=20)
    role: str | None = None                                          # 受注区分
    jv_name: str | None = Field(default=None, max_length=120)
    jv_members: list[str] = Field(default_factory=list, max_length=20)
    sources: list[SourceIn] = Field(default_factory=list, max_length=20)
    verify: dict[str, bool] = Field(default_factory=dict)             # 項目ごとの「確認済み」


def _contract(b: ContractIn | None, old: dict | None, u: dict) -> dict | None:
    """契約の値を確かめて整える。確認済みの項目には、確認した人と日時を残す（値も確認も変わらなければ前のまま）。"""
    if b is None:
        return old
    old = old or {}
    s = lambda x: (x or '').strip() or None
    d = lambda x: x.isoformat() if x else None
    if b.period_start and b.period_end and b.period_end < b.period_start:
        raise HTTPException(400, '工期の終了は開始より後にしてください')
    if b.award_date and b.contract_date and b.contract_date < b.award_date:
        raise HTTPException(400, '契約締結日は落札決定日より後にしてください')
    if b.role is not None and b.role not in ROLES_JV:
        raise HTTPException(400, '受注区分が正しくありません')
    members = [m.strip() for m in b.jv_members if m and m.strip()]
    if any(len(m) > 80 for m in members):
        raise HTTPException(400, 'JV の構成員の名前が長すぎます')
    if b.role == '単独' and (s(b.jv_name) or members):
        raise HTTPException(400, '単独受注のときは JV の名前・構成員を入れないでください')
    changes = []
    for ch in sorted(b.changes, key=lambda x: x.date):
        st = ch.period_start or b.period_start
        if st and ch.period_end < st:
            raise HTTPException(400, '変更後の工期の終了は開始より後にしてください')
        changes.append({'date': d(ch.date), 'period_start': d(ch.period_start), 'period_end': d(ch.period_end), 'note': s(ch.note)})
    sources = []
    for src in b.sources:
        if src.kind not in SOURCE_KINDS:
            raise HTTPException(400, '出典の種類が正しくありません')
        if src.url and not src.url.strip().lower().startswith(('https://', 'http://')):
            raise HTTPException(400, '出典の URL は http:// か https:// で始めてください')
        sources.append({'kind': src.kind, 'title': src.title.strip(), 'url': s(src.url), 'checked_on': d(src.checked_on)})
    c = {'title': s(b.title), 'place': s(b.place), 'agency': s(b.agency), 'agency_no': s(b.agency_no), 'award_date': d(b.award_date),
         'contract_date': d(b.contract_date), 'period_start': d(b.period_start), 'period_end': d(b.period_end), 'changes': changes,
         'role': b.role, 'jv_name': s(b.jv_name), 'jv_members': members, 'sources': sources}
    val = {'title': c['title'], 'place': c['place'], 'agency': c['agency'], 'agency_no': c['agency_no'], 'award_date': c['award_date'],
           'contract_date': c['contract_date'], 'period': [c['period_start'], c['period_end']], 'changes': changes, 'role': c['role'],
           'jv': [c['jv_name'], members]}
    oldv = {'title': old.get('title'), 'place': old.get('place'), 'agency': old.get('agency'), 'agency_no': old.get('agency_no'),
            'award_date': old.get('award_date'), 'contract_date': old.get('contract_date'), 'period': [old.get('period_start'), old.get('period_end')],
            'changes': old.get('changes', []), 'role': old.get('role'), 'jv': [old.get('jv_name'), old.get('jv_members', [])]}
    bad = set(b.verify) - set(VERIFY_FIELDS)
    if bad:
        raise HTTPException(400, '確認の項目が正しくありません')
    verify, ov = {}, old.get('verify') or {}
    for f, ok in b.verify.items():
        if not ok:
            continue
        empty = val[f] in (None, [], [None, None], [None, []])
        if empty:
            continue                                   # 空の項目は「確認済み」にしない
        verify[f] = ov[f] if f in ov and val[f] == oldv[f] else {'by': u['email'], 'at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    c['verify'] = verify
    if not any(v for k, v in c.items() if k != 'verify'):
        return None                                    # 何も入っていなければ持たない
    return c


def _contract_changes(old: dict | None, new: dict | None) -> list[str]:
    old, new = old or {}, new or {}
    keys = {'title', 'place', 'agency', 'agency_no', 'award_date', 'contract_date', 'period_start', 'period_end', 'changes', 'role',
            'jv_name', 'jv_members', 'sources'}
    out = [f'contract.{k}' for k in sorted(keys) if old.get(k) != new.get(k)]
    if {k: v.get('by') for k, v in (old.get('verify') or {}).items()} != {k: v.get('by') for k, v in (new.get('verify') or {}).items()}:
        out.append('contract.verify')
    return out


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    br: str = Field(min_length=2, max_length=4)
    port: str = Field(min_length=1, max_length=40)
    client: str = Field(min_length=1, max_length=80)
    ccat: str
    kind: str
    start: date
    soil: str
    lon: float = Field(ge=122, le=154, allow_inf_nan=False)
    lat: float = Field(ge=20, le=46.5, allow_inf_nan=False)
    w: float = Field(ge=SIZE_MIN, le=SIZE_MAX, allow_inf_nan=False)
    d: float = Field(ge=SIZE_MIN, le=SIZE_MAX, allow_inf_nan=False)
    sea: str | None = None
    design: float | None = Field(default=None, ge=-40, le=30, allow_inf_nan=False)     # 海上工事：計画水深・計画天端（T.P. m）
    seabed: float | None = Field(default=None, ge=-60, le=10, allow_inf_nan=False)     # 海上工事：いまの海底（T.P. m）。仮の海底に使う
    version: int | None = Field(default=None, ge=1)
    contract: ContractIn | None = None                 # 省略＝変えない


def _clean(c, b: SiteIn) -> tuple[dict, dict]:
    L = ledger_enums(c)
    kinds = L.get('kinds') or {}
    for v, opts, name in ((b.br, L.get('branches') or {}, '支店'), (b.kind, kinds, '工種'), (b.soil, L.get('soils') or {}, '土質'),
                          (b.ccat, L.get('ccats') or [], '発注者の区分')):
        if v not in opts:
            raise HTTPException(400, f'{name}が正しくありません')
    if b.sea is not None and b.sea not in (L.get('seas') or []):
        raise HTTPException(400, '海側の向きが正しくありません')
    if not date(2000, 1, 1) <= b.start <= date(2100, 1, 1):
        raise HTTPException(400, '着工日が正しくありません')
    for f in ('name', 'port', 'client'):
        if not getattr(b, f).strip():
            raise HTTPException(400, '空白だけの項目があります')
    k = kinds[b.kind]
    if k.get('marine') and b.design is None:
        raise HTTPException(400, '海上工事は計画水深・計画天端（T.P. m）が必要です')
    data = {'name': b.name.strip(), 'br': b.br, 'port': b.port.strip(), 'client': b.client.strip(), 'ccat': b.ccat, 'kind': b.kind,
            'start': b.start.isoformat(), 'soil': b.soil, 'lon': round(b.lon, 7), 'lat': round(b.lat, 7), 'w': round(b.w), 'd': round(b.d), 'sea': b.sea}
    if k.get('marine'):
        data['design'] = round(b.design, 1)
    return data, k


def _in_scope_br(u: dict, br: str) -> None:
    sb = scope_branches(u)
    if sb is not None and br not in sb:
        raise HTTPException(404, '支店が見つかりません')     # 範囲外の支店には登録・移動できない（有無を区別しない）


def _history(c, key: str, version: int, action: str, data: dict, fields: list[str] | None, uid: int) -> None:
    c.execute('INSERT INTO portal.site_history(site_key, version, action, data, changed_fields, user_id) VALUES (%s,%s,%s,%s,%s,%s)',
              (key, version, action, Jsonb(data), fields, uid))


@router.post('/api/sites')
def create_site(body: SiteIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        _in_scope_br(u, body.br)
        data, k = _clean(c, body)
        if k.get('marine'):
            if body.seabed is None:
                raise HTTPException(400, '海上工事は、いまの海底の高さ（T.P. m）が必要です（深浅測量を登録するまでの仮の海底に使います）')
            data['survey'] = placeholder_survey(data['w'], data['d'], round(body.seabed, 1))
            data['seabed'] = round(body.seabed, 1)
        for _ in range(5):
            key = f"{body.br.lower()}_{secrets.token_hex(3)}"
            if not c.execute('SELECT 1 FROM portal.sites WHERE key=%s', (key,)).fetchone():
                break
        seq = c.execute("SELECT coalesce(max((data->>'seq')::int), -1) + 1 AS n FROM portal.sites").fetchone()['n']
        data = {'key': key, **data, 'no': next_number(c, body.br, data['start']), 'seq': seq, 'sample': False, 'perf': 1}
        ct = _contract(body.contract, None, u)
        if ct:
            data['contract'] = ct
        c.execute("INSERT INTO portal.sites(key, data, origin, version, updated_by) VALUES (%s,%s,'portal',1,%s)", (key, Jsonb(data), u['id']))
        _history(c, key, 1, 'create', data, None, u['id'])
        audit(c, u['id'], 'site_create', {'site': key, 'br': body.br, 'kind': body.kind}, client_ip(req))
    return {'ok': True, 'key': key, 'no': data['no'], 'version': 1}


@router.put('/api/sites/{key}')
def update_site(key: str, body: SiteIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    if body.version is None:
        raise HTTPException(400, '版（version）が必要です')
    with connect() as c:
        row = c.execute('SELECT data, version FROM portal.sites WHERE key=%s AND archived_at IS NULL FOR UPDATE', (key,)).fetchone()
        if not row:
            raise HTTPException(404, '現場が見つかりません')
        check_site(c, u, key)                 # いまの支店が範囲内か
        _in_scope_br(u, body.br)              # 移す先の支店も範囲内か
        old = row['data']
        if row['version'] != body.version:
            raise HTTPException(409, {'message': 'ほかの人が先にこの現場の台帳を更新しました。読み込み直してから、もう一度入力してください',
                                      'version': row['version']})
        new, k = _clean(c, body)
        changed = sorted(f for f in new if new[f] != old.get(f))
        ct = _contract(body.contract, old.get('contract'), u)
        changed += _contract_changes(old.get('contract'), ct)
        if body.kind != old['kind'] and c.execute('SELECT 1 FROM portal.progress WHERE site_key=%s LIMIT 1', (key,)).fetchone():
            raise HTTPException(409, {'message': '実績が入力されているため、工種は変えられません（工程の並びが変わり、実績が別の工程に付いてしまいます）'})
        moved = any(new[f] != old.get(f) for f in ('lon', 'lat', 'w', 'd'))
        merged = {**old, **new}
        if ct is None:
            merged.pop('contract', None)
        else:
            merged['contract'] = ct
        if k.get('marine'):
            sv = old.get('survey') or {}
            has_surveys = c.execute('SELECT 1 FROM portal.surveys WHERE site_key=%s AND deleted_at IS NULL LIMIT 1', (key,)).fetchone()
            if moved and (has_surveys or (sv and sv.get('src') != PLACEHOLDER_SRC)):
                raise HTTPException(409, {'message': '深浅測量がある海上工事は、位置・範囲を変えられません（測量の格子と合わなくなります）'})
            seabed = body.seabed if body.seabed is not None else old.get('seabed')
            if not sv or (sv.get('src') == PLACEHOLDER_SRC and (moved or (body.seabed is not None and body.seabed != old.get('seabed')))):
                if seabed is None:
                    raise HTTPException(400, '海上工事は、いまの海底の高さ（T.P. m）が必要です')
                merged['survey'] = placeholder_survey(new['w'], new['d'], round(seabed, 1))
                merged['seabed'] = round(seabed, 1)
                changed = sorted(set(changed) | {'seabed'})
        elif 'survey' in merged and old['kind'] != body.kind:
            merged.pop('survey', None); merged.pop('design', None)
        if not changed:
            return {'ok': True, 'key': key, 'version': row['version'], 'changed': []}
        v = row['version'] + 1
        n = c.execute("""UPDATE portal.sites SET data=%s, version=%s, origin='portal', updated_by=%s, updated_at=now()
                         WHERE key=%s AND version=%s""", (Jsonb(merged), v, u['id'], key, body.version)).rowcount
        if n != 1:
            raise HTTPException(409, {'message': 'ほかの人が先にこの現場の台帳を更新しました。読み込み直してください'})
        _history(c, key, v, 'update', merged, changed, u['id'])
        audit(c, u['id'], 'site_update', {'site': key, 'fields': changed}, client_ip(req))
    return {'ok': True, 'key': key, 'version': v, 'changed': changed, 'moved': moved}


class VersionIn(BaseModel):
    version: int = Field(ge=1)


@router.post('/api/sites/{key}/archive')
def archive_site(key: str, body: VersionIn, req: Request):
    """完了・中止：一覧・計算・日次の記録から外す（データは消さない。戻せるのは管理者）。"""
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        row = c.execute('SELECT data, version FROM portal.sites WHERE key=%s AND archived_at IS NULL FOR UPDATE', (key,)).fetchone()
        if not row:
            raise HTTPException(404, '現場が見つかりません')
        check_site(c, u, key)
        if row['version'] != body.version:
            raise HTTPException(409, {'message': 'ほかの人が先にこの現場の台帳を更新しました。読み込み直してください', 'version': row['version']})
        v = row['version'] + 1
        c.execute("UPDATE portal.sites SET archived_at=now(), version=%s, origin='portal', updated_by=%s, updated_at=now() WHERE key=%s", (v, u['id'], key))
        _history(c, key, v, 'archive', row['data'], None, u['id'])
        audit(c, u['id'], 'site_archive', {'site': key}, client_ip(req))
    return {'ok': True}


@router.post('/api/sites/{key}/restore')
def restore_site(key: str, req: Request):
    require_csrf(req)
    u = require(req, 'admin')
    with connect() as c:
        row = c.execute('SELECT data, version FROM portal.sites WHERE key=%s AND archived_at IS NOT NULL FOR UPDATE', (key,)).fetchone()
        if not row:
            raise HTTPException(404, '完了した現場が見つかりません')
        v = row['version'] + 1
        c.execute('UPDATE portal.sites SET archived_at=NULL, version=%s, updated_by=%s, updated_at=now() WHERE key=%s', (v, u['id'], key))
        _history(c, key, v, 'restore', row['data'], None, u['id'])
        audit(c, u['id'], 'site_restore', {'site': key}, client_ip(req))
    return {'ok': True}


@router.get('/api/sites/archived')
def archived_sites(req: Request):
    u = require(req, 'admin')
    with connect() as c:
        rows = list(c.execute("""SELECT key, data->>'no' AS no, data->>'name' AS name, data->>'br' AS br, archived_at FROM portal.sites
                                 WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"""))
    return [{**r, 'archived_at': r['archived_at'].isoformat()} for r in rows]


@router.get('/api/sites/{key}/history')
def site_history(key: str, req: Request):
    u = require(req)
    with connect() as c:
        if not c.execute('SELECT 1 FROM portal.sites WHERE key=%s AND archived_at IS NULL', (key,)).fetchone():
            raise HTTPException(404, '現場が見つかりません')
        check_site(c, u, key)
        rows = list(c.execute("""SELECT h.version, h.action, h.changed_fields, h.at, u.email FROM portal.site_history h
                                 LEFT JOIN portal.users u ON u.id=h.user_id WHERE h.site_key=%s ORDER BY h.id DESC LIMIT 50""", (key,)))
    return [{**r, 'at': r['at'].isoformat()} for r in rows]
