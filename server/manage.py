"""管理用のコマンド。

  python3 -m server.manage migrate                         … スキーマを最新にする（追加のみ）
  python3 -m server.manage seed                            … マスタ（地域係数・台帳の選択肢など）を online/data から取り込む（何度でも可）
  python3 -m server.manage seed --sample                   … 上に加えて、架空の現場（17）と作業船（デモ）も取り込む（試験・デモ用。本番では使わない）
  python3 -m server.manage purge-sample-sites [--yes]      … 架空の現場（seed で入れたもの）と作業船（デモ）を消す（先にバックアップ。--yes が無ければ確認だけ）
  python3 -m server.manage create-user メール --role admin  … 利用者を作る（パスワードは画面に出さずに入力）
      閲覧者・編集者は見られる支店の指定が必須：--branches HK,TH（支店のコード）か --all（全支店）。管理者は常に全支店
  python3 -m server.manage set-branches メール HK,TH|all|none … 見られる支店を変える（all＝全支店、none＝どこも見られない）
  python3 -m server.manage set-password メール               … パスワードを変える（ロックも解除）
  python3 -m server.manage disable-user メール               … 利用できないようにする（セッションも切る）
  python3 -m server.manage list-users                      … 利用者の一覧
  python3 -m server.manage backup ファイル                  … pg_dump でバックアップ（スキーマ portal）
  python3 -m server.manage notify [--dry-run]              … 遅れの予兆をメールで知らせる（設定が有効で条件がそろうときだけ。1日1回まで）
"""
import argparse
import getpass
import json
import os
import pathlib
import subprocess
import sys

from psycopg.types.json import Jsonb

from .db import connect, migrate, database_url
from .security import hash_password, audit, ROLES

ROOT = pathlib.Path(__file__).resolve().parent.parent


def seed(url=None, sample: bool = False):
    """マスタを取り込む。sample=True のときだけ、架空の現場と作業船（デモ）も取り込む（試験用 DB・デモ用）。"""
    data = ROOT / 'online' / 'data'
    sites = json.loads((data / 'sites.json').read_text(encoding='utf-8'))
    master = json.loads((data / 'master.json').read_text(encoding='utf-8'))
    japan = json.loads((data / 'japan.json').read_text(encoding='utf-8'))
    vessels = master.pop('vessels', [])
    with connect(url) as c:
        if not sample:
            for k, v in (('master', master), ('japan', japan)):
                c.execute('INSERT INTO portal.master(key, data) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', (k, Jsonb(v)))
            return 0, 0
        # 台帳は DB が正：画面で登録・編集した現場（origin='portal'）と完了した現場は上書きしない。工事番号（no）は残す
        for i, s in enumerate(sites):
            c.execute("""INSERT INTO portal.sites(key, data) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE
                         SET data = EXCLUDED.data || CASE WHEN portal.sites.data ? 'no' THEN jsonb_build_object('no', portal.sites.data->'no') ELSE '{}'::jsonb END,
                             updated_at = now()
                         WHERE portal.sites.origin = 'seed' AND portal.sites.archived_at IS NULL""",
                      (s['key'], Jsonb({**s, 'seq': i})))
        kept = [r['key'] for r in c.execute("SELECT key FROM portal.sites WHERE key = ANY(%s) AND (origin <> 'seed' OR archived_at IS NOT NULL)",
                                            ([s['key'] for s in sites],))]
        if kept:
            print('画面で編集・完了した現場は取り込み元で上書きしませんでした：', ', '.join(kept))
        extra = [r['key'] for r in c.execute("SELECT key FROM portal.sites WHERE origin = 'seed' AND NOT (key = ANY(%s))", ([s['key'] for s in sites],))]
        if extra:   # 台帳から外れた現場は消さない（消すと実績もカスケードで消える）。必要なら手作業で
            print('注意：取り込み元に無い現場が DB に残っています（消していません）：', ', '.join(extra))
        from .sites import assign_missing_numbers
        assign_missing_numbers(c)
        for k, v in (('master', master), ('japan', japan)):
            c.execute('INSERT INTO portal.master(key, data) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', (k, Jsonb(v)))
        # 作業船（デモ）：上書きで取り込む。配船計画が参照している船は消せないので、台帳から外れても残す
        for v in vessels:
            extra = {k: v[k] for k in ('len', 'beam', 'color', 'pref', 'radius', 'period', 'phase') if k in v}
            c.execute("""INSERT INTO portal.vessels(id, name, type, site_key, lon, lat, source, extra) VALUES (%s,%s,%s,%s,%s,%s,'demo',%s)
                         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, site_key=EXCLUDED.site_key, lon=EXCLUDED.lon,
                         lat=EXCLUDED.lat, extra=EXCLUDED.extra, updated_at=now() WHERE portal.vessels.source='demo'""",
                      (v['id'], v['name'], v['type'], v.get('site'), v['lon'], v['lat'], Jsonb(extra)))
        gone = [r['id'] for r in c.execute("SELECT id FROM portal.vessels WHERE source='demo' AND NOT (id = ANY(%s))", ([v['id'] for v in vessels],))]
        for vid in gone:
            if c.execute('SELECT 1 FROM portal.vessel_assignments WHERE vessel_id=%s LIMIT 1', (vid,)).fetchone():
                print('注意：台帳から外れた作業船（デモ）が配船計画で使われているため残しました：', vid)
            else:
                c.execute('DELETE FROM portal.vessels WHERE id=%s', (vid,))
    return len(sites), len(vessels)


def parse_branches(spec: str | None, role: str, url=None) -> list[str] | None:
    """--branches の値 → DB の値（None＝全支店、[]＝なし）。支店のコードは現場台帳にあるものだけ。"""
    if role == 'admin':
        if spec not in (None, 'all'):
            sys.exit('管理者は常に全支店です（--branches は指定できません）')
        return None
    if spec is None:
        sys.exit('閲覧者・編集者は見られる支店を指定してください：--branches HK,TH（支店のコード）か --all（全支店）')
    if spec == 'all':
        return None
    if spec == 'none':
        return []
    codes = sorted({x.strip().upper() for x in spec.split(',') if x.strip()})
    with connect(url) as c:
        known = {r['br'] for r in c.execute("SELECT DISTINCT data->>'br' AS br FROM portal.sites")}
    bad = [x for x in codes if x not in known]
    if bad or not codes:
        sys.exit(f"支店のコードが正しくありません：{', '.join(bad) or '（空）'}（使えるコード：{', '.join(sorted(known))}）")
    return codes


def scope_text(role, branches) -> str:
    return '全支店' if role == 'admin' or branches is None else ('なし' if not branches else ','.join(branches))


DEPENDENT = ('progress', 'progress_history', 'surveys', 'consultations', 'map_features', 'vessel_assignments')


def sample_site_keys(c) -> list[str]:
    """架空の現場：seed で取り込み、画面で登録・編集していないもの（origin='seed'）。"""
    return [r['key'] for r in c.execute("SELECT key FROM portal.sites WHERE origin='seed' AND coalesce(data->>'sample','') <> 'false' ORDER BY key")]


def purge_sample_sites(yes: bool = False, url=None, backup_dir: pathlib.Path | None = None) -> dict:
    """架空の現場と作業船（デモ）を消す。実績・測量・協議・区域・配船がひも付いている現場があれば、何も消さずに止まる。
    先にバックアップを取る（復元は運用管理手順書の手順、または seed --sample で架空の現場を入れ直す）。"""
    with connect(url) as c:
        keys = sample_site_keys(c)
        cnt = {t: c.execute(f'SELECT count(*) AS n FROM portal.{t} WHERE site_key = ANY(%s)', (keys,)).fetchone()['n'] for t in DEPENDENT}
        snaps = c.execute('SELECT count(*) AS n FROM portal.delay_snapshots WHERE site_key = ANY(%s)', (keys,)).fetchone()['n']
        demo = c.execute("SELECT count(*) AS n FROM portal.vessels WHERE source='demo'").fetchone()['n']
        demo_used = c.execute("""SELECT count(*) AS n FROM portal.vessel_assignments a JOIN portal.vessels v ON v.id=a.vessel_id
                                 WHERE v.source='demo' AND NOT (a.site_key = ANY(%s))""", (keys,)).fetchone()['n']
    plan = {'sites': len(keys), 'snapshots': snaps, 'demo_vessels': demo, 'dependent': cnt, 'demo_vessels_used_by_real_sites': demo_used}
    print('消す予定：架空の現場', len(keys), '件', keys)
    print('　日次の記録', snaps, '件・作業船（デモ）', demo, '隻')
    if any(cnt.values()) or demo_used:
        print('止めました：架空の現場に実データ（実績・測量・協議・区域・配船）がひも付いています。内容を確かめてください：', cnt, '／実際の現場の配船に使われている作業船（デモ）', demo_used)
        return {**plan, 'done': False, 'reason': 'dependent'}
    if not yes:
        print('確認だけです（消していません）。消すときは --yes を付けてください')
        return {**plan, 'done': False, 'reason': 'dry-run'}
    if url is None:   # 本番：先にバックアップ（本人だけが読める権限）
        from datetime import datetime
        d = backup_dir or pathlib.Path.home() / 'backups' / 'mirai-3d-portal'
        d.mkdir(parents=True, exist_ok=True)
        main(['backup', str(d / f"before-purge-sample-{datetime.now():%Y%m%d-%H%M%S}.dump")])
    with connect(url) as c:
        c.execute('DELETE FROM portal.delay_snapshots WHERE site_key = ANY(%s)', (keys,))
        c.execute('DELETE FROM portal.site_history WHERE site_key = ANY(%s)', (keys,))
        c.execute("DELETE FROM portal.vessels WHERE source='demo'")
        n = c.execute('DELETE FROM portal.sites WHERE key = ANY(%s)', (keys,)).rowcount
        audit(c, None, 'purge_sample_sites', {'sites': n, 'snapshots': snaps, 'demo_vessels': demo, 'by': 'cli'})
    print(f'消しました：架空の現場 {n} 件・日次の記録 {snaps} 件・作業船（デモ） {demo} 隻')
    return {**plan, 'done': True}


def ask_password() -> str:
    a = getpass.getpass('パスワード（12文字以上）: ')
    b = getpass.getpass('もう一度: ')
    if a != b:
        sys.exit('パスワードが一致しません')
    return a


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python3 -m server.manage')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('migrate'); sub.add_parser('list-users')
    p = sub.add_parser('seed'); p.add_argument('--sample', action='store_true')
    p = sub.add_parser('purge-sample-sites'); p.add_argument('--yes', action='store_true')
    p = sub.add_parser('create-user'); p.add_argument('email'); p.add_argument('--role', choices=ROLES, default='viewer')
    g = p.add_mutually_exclusive_group(); g.add_argument('--branches'); g.add_argument('--all', action='store_true')
    p = sub.add_parser('set-branches'); p.add_argument('email'); p.add_argument('branches')
    p = sub.add_parser('set-password'); p.add_argument('email')
    p = sub.add_parser('disable-user'); p.add_argument('email')
    p = sub.add_parser('backup'); p.add_argument('file')
    p = sub.add_parser('notify'); p.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    if a.cmd == 'migrate':
        print('適用したマイグレーション:', migrate() or 'なし（最新）')
    elif a.cmd == 'seed':
        n, v = seed(sample=a.sample)
        print(f'マスタを取り込みました' + (f'（架空の現場 {n} 件・作業船（デモ）{v} 隻も）' if a.sample else '（架空の現場・作業船（デモ）は取り込んでいません）'))
    elif a.cmd == 'purge-sample-sites':
        purge_sample_sites(yes=a.yes)
    elif a.cmd == 'create-user':
        email = a.email.strip().lower()
        branches = parse_branches('all' if a.all else a.branches, a.role)
        try:
            h = hash_password(ask_password())
        except ValueError as e:
            sys.exit(str(e))
        with connect() as c:
            c.execute('INSERT INTO portal.users(email, pw_hash, role, branches) VALUES (%s,%s,%s,%s)', (email, h, a.role, branches))
            audit(c, None, 'user_create', {'email': email, 'role': a.role, 'branches': branches, 'by': 'cli'})
        print(f'{email}（{a.role}・閲覧範囲 {scope_text(a.role, branches)}）を作りました')
    elif a.cmd == 'set-branches':
        email = a.email.strip().lower()
        with connect() as c:
            u = c.execute('SELECT id, role FROM portal.users WHERE email=%s', (email,)).fetchone()
        if not u:
            sys.exit('その利用者はいません')
        branches = parse_branches(a.branches.strip().lower() if a.branches.strip().lower() in ('all', 'none') else a.branches, u['role'])
        with connect() as c:
            c.execute('UPDATE portal.users SET branches=%s WHERE id=%s', (branches, u['id']))
            c.execute('DELETE FROM portal.sessions WHERE user_id=%s', (u['id'],))   # 次の画面の読み込みから新しい範囲にする
            audit(c, u['id'], 'user_branches', {'branches': branches, 'by': 'cli'})
        print(f'{email} の閲覧範囲を {scope_text(u["role"], branches)} にしました（ログインし直しが必要です）')
    elif a.cmd == 'set-password':
        email = a.email.strip().lower()
        try:
            h = hash_password(ask_password())
        except ValueError as e:
            sys.exit(str(e))
        with connect() as c:
            n = c.execute('UPDATE portal.users SET pw_hash=%s, failed_count=0, locked_until=NULL, pw_changed_at=now() WHERE email=%s RETURNING id', (h, email)).fetchone()
            if not n:
                sys.exit('その利用者はいません')
            c.execute('DELETE FROM portal.sessions WHERE user_id=%s', (n['id'],))
            audit(c, n['id'], 'password_reset', {'by': 'cli'})
        print('パスワードを変えました（ほかの端末のログインは切れます）')
    elif a.cmd == 'disable-user':
        with connect() as c:
            n = c.execute('UPDATE portal.users SET active=false WHERE email=%s RETURNING id', (a.email.strip().lower(),)).fetchone()
            if not n:
                sys.exit('その利用者はいません')
            c.execute('DELETE FROM portal.sessions WHERE user_id=%s', (n['id'],))
            audit(c, n['id'], 'user_disable', {'by': 'cli'})
        print('利用できないようにしました')
    elif a.cmd == 'notify':
        from .trends import notify
        r = notify(dry_run=a.dry_run)
        print(json.dumps({k: v for k, v in r.items() if k not in ('body',)} if not a.dry_run else r, ensure_ascii=False, indent=1))
        if r['status'] == 'failed':
            sys.exit(1)
    elif a.cmd == 'list-users':
        with connect() as c:
            for r in c.execute('SELECT email, role, active, branches, last_login_at, locked_until FROM portal.users ORDER BY id'):
                print(f"{r['email']:<40} {r['role']:<7} {'有効' if r['active'] else '停止'}  閲覧範囲 {scope_text(r['role'], r['branches']):<12} "
                      f"最終ログイン {r['last_login_at'] or '—'}{'  ロック中' if r['locked_until'] else ''}")
    elif a.cmd == 'backup':
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        info = conninfo_to_dict(database_url())
        env = {**os.environ}
        if info.get('password'):
            env['PGPASSWORD'] = info.pop('password')   # パスワードはコマンドライン（ps で見える）に出さない
        out = pathlib.Path(a.file)
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # 作った時点から本人だけが読める
        with os.fdopen(fd, 'wb') as f:
            subprocess.run(['pg_dump', '--schema=portal', '--no-owner', '--format=custom', '--dbname', make_conninfo(**info)], stdout=f, check=True, env=env)
        print(f'バックアップしました：{out}（{out.stat().st_size:,} バイト）')


if __name__ == '__main__':
    main()
