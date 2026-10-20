"""管理用のコマンド。

  python3 -m server.manage migrate                         … スキーマを最新にする（追加のみ）
  python3 -m server.manage seed                            … 現場台帳・マスタ・作業船（デモ）を online/data から取り込む（何度でも可）
  python3 -m server.manage create-user メール --role admin  … 利用者を作る（パスワードは画面に出さずに入力）
  python3 -m server.manage set-password メール               … パスワードを変える（ロックも解除）
  python3 -m server.manage disable-user メール               … 利用できないようにする（セッションも切る）
  python3 -m server.manage list-users                      … 利用者の一覧
  python3 -m server.manage backup ファイル                  … pg_dump でバックアップ（スキーマ portal）
  python3 -m server.manage create-service-account          … 定時処理（日次の記録）の専用アカウントを作り、server/.env に書く（パスワードは表示しない）
  python3 -m server.manage notify [--dry-run]              … 遅れの予兆をメールで知らせる（設定が有効で条件がそろうときだけ。1日1回まで）
"""
import argparse
import secrets
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


def seed(url=None):
    data = ROOT / 'online' / 'data'
    sites = json.loads((data / 'sites.json').read_text(encoding='utf-8'))
    master = json.loads((data / 'master.json').read_text(encoding='utf-8'))
    japan = json.loads((data / 'japan.json').read_text(encoding='utf-8'))
    vessels = master.pop('vessels', [])
    with connect(url) as c:
        for i, s in enumerate(sites):
            c.execute("""INSERT INTO portal.sites(key, data) VALUES (%s,%s) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()""",
                      (s['key'], Jsonb({**s, 'seq': i})))
        extra = [r['key'] for r in c.execute('SELECT key FROM portal.sites WHERE NOT (key = ANY(%s))', ([s['key'] for s in sites],))]
        if extra:   # 台帳から外れた現場は消さない（消すと実績もカスケードで消える）。必要なら手作業で
            print('注意：取り込み元に無い現場が DB に残っています（消していません）：', ', '.join(extra))
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


SERVICE_EMAIL = 'snapshot-job@portal.invalid'


def set_env(path: pathlib.Path, values: dict) -> None:
    """server/.env の行を置き換える（無ければ足す）。本人だけが読める権限で書き、値は画面に出さない。"""
    lines = path.read_text(encoding='utf-8').splitlines() if path.exists() else []
    keep = [x for x in lines if x.split('=', 1)[0].strip() not in values]
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(keep + [f'{k}={v}' for k, v in values.items()]) + '\n')
    os.replace(tmp, path)


def create_service_account(env_path: pathlib.Path | None = None) -> str:
    """閲覧者の権限の専用アカウント（ほかの操作はできない）。日次の記録を書けるのは、このアカウントがサーバ自身から送ったときだけ。"""
    pw = secrets.token_urlsafe(32)
    with connect() as c:
        r = c.execute("""INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,'viewer')
                         ON CONFLICT (email) DO UPDATE SET pw_hash=EXCLUDED.pw_hash, role='viewer', active=true, failed_count=0, locked_until=NULL, pw_changed_at=now()
                         RETURNING id""", (SERVICE_EMAIL, hash_password(pw))).fetchone()
        c.execute('DELETE FROM portal.sessions WHERE user_id=%s', (r['id'],))
        audit(c, r['id'], 'service_account', {'by': 'cli'})
    set_env(env_path or ROOT / 'server' / '.env', {'SNAPSHOT_EMAIL': SERVICE_EMAIL, 'SNAPSHOT_PASSWORD': pw})
    return SERVICE_EMAIL


def ask_password() -> str:
    a = getpass.getpass('パスワード（12文字以上）: ')
    b = getpass.getpass('もう一度: ')
    if a != b:
        sys.exit('パスワードが一致しません')
    return a


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python3 -m server.manage')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('migrate'); sub.add_parser('seed'); sub.add_parser('list-users')
    p = sub.add_parser('create-user'); p.add_argument('email'); p.add_argument('--role', choices=ROLES, default='viewer')
    p = sub.add_parser('set-password'); p.add_argument('email')
    p = sub.add_parser('disable-user'); p.add_argument('email')
    p = sub.add_parser('backup'); p.add_argument('file')
    sub.add_parser('create-service-account')
    p = sub.add_parser('notify'); p.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    if a.cmd == 'migrate':
        print('適用したマイグレーション:', migrate() or 'なし（最新）')
    elif a.cmd == 'seed':
        n, v = seed(); print(f'現場 {n} 件・作業船（デモ）{v} 隻を取り込みました')
    elif a.cmd == 'create-user':
        email = a.email.strip().lower()
        try:
            h = hash_password(ask_password())
        except ValueError as e:
            sys.exit(str(e))
        with connect() as c:
            c.execute('INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,%s)', (email, h, a.role))
            audit(c, None, 'user_create', {'email': email, 'role': a.role, 'by': 'cli'})
        print(f'{email}（{a.role}）を作りました')
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
    elif a.cmd == 'create-service-account':
        email = create_service_account()
        print(f'{email}（閲覧者・定時処理の専用）を作り、server/.env に SNAPSHOT_EMAIL と SNAPSHOT_PASSWORD を書きました（パスワードは表示しません）。サービスの再起動が必要です')
    elif a.cmd == 'notify':
        from .trends import notify
        r = notify(dry_run=a.dry_run)
        print(json.dumps({k: v for k, v in r.items() if k not in ('body',)} if not a.dry_run else r, ensure_ascii=False, indent=1))
        if r['status'] == 'failed':
            sys.exit(1)
    elif a.cmd == 'list-users':
        with connect() as c:
            for r in c.execute('SELECT email, role, active, last_login_at, locked_until FROM portal.users ORDER BY id'):
                print(f"{r['email']:<40} {r['role']:<7} {'有効' if r['active'] else '停止'}  最終ログイン {r['last_login_at'] or '—'}{'  ロック中' if r['locked_until'] else ''}")
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
