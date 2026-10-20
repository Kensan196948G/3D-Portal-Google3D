"""データベース（PostgreSQL）への接続と、マイグレーションの実行。"""
import os
import pathlib
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

HERE = pathlib.Path(__file__).resolve().parent
load_dotenv(HERE / '.env')


def database_url() -> str:
    url = os.environ.get('DATABASE_URL', '')
    if not url:
        raise RuntimeError('DATABASE_URL が設定されていません（server/.env）')
    return url


@contextmanager
def connect(url: str | None = None):
    """1回の処理で使う接続。正常に終われば commit、例外なら rollback。"""
    conn = psycopg.connect(url or database_url(), row_factory=dict_row, connect_timeout=5)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def migrate(url: str | None = None) -> list[str]:
    """server/migrations/NNNN_*.sql（.down.sql を除く）を番号順に1回ずつ当てる。"""
    applied = []
    with connect(url) as c:
        c.execute('CREATE SCHEMA IF NOT EXISTS portal')
        c.execute('CREATE TABLE IF NOT EXISTS portal.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
        done = {r['version'] for r in c.execute('SELECT version FROM portal.schema_migrations')}
        for f in sorted((HERE / 'migrations').glob('[0-9][0-9][0-9][0-9]_*.sql')):
            if f.name.endswith('.down.sql') or f.stem in done:
                continue
            c.execute(f.read_text(encoding='utf-8'))
            c.execute('INSERT INTO portal.schema_migrations(version) VALUES (%s)', (f.stem,))
            applied.append(f.stem)
    return applied
