"""サーバのテスト：専用のテスト用 DB（TEST_DATABASE_URL）を毎回作り直して使う。本番の DB には触らない。"""
import os
import pathlib

from dotenv import load_dotenv

load_dotenv(pathlib.Path(__file__).resolve().parents[1] / '.env')
TEST_URL = os.environ.get('TEST_DATABASE_URL')
if not TEST_URL:
    raise RuntimeError('TEST_DATABASE_URL が必要です（server/.env か環境変数）')
assert TEST_URL != os.environ.get('DATABASE_URL_PROD', ''), 'テストに本番の DB は使えません'
os.environ['DATABASE_URL'] = TEST_URL          # 以降に読み込むサーバのモジュールはテスト用 DB を使う
os.environ['GOOGLE_MAP_TILES_KEY'] = 'test-key-not-real'
os.environ['LOGIN_IP_MAX'] = '1000'
os.environ['AI_ENABLED'] = '0'
os.environ.pop('AIS_INGEST_TOKEN', None)

import psycopg
import pytest
from fastapi.testclient import TestClient

from server.db import migrate
from server.manage import seed
from server.security import PH

PW = {'admin@example.com': 'admin-pass-123456', 'editor@example.com': 'editor-pass-123456', 'viewer@example.com': 'viewer-pass-123456'}


@pytest.fixture(scope='session', autouse=True)
def database():
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute('DROP SCHEMA IF EXISTS portal CASCADE')
    migrate(TEST_URL)
    seed(TEST_URL)
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        for email, pw in PW.items():
            c.execute('INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,%s)', (email, PH.hash(pw), email.split('@')[0]))
    yield


@pytest.fixture
def client():
    from server.app import app
    return TestClient(app)


H = {'X-Portal-Request': '1'}


def login(client, email):
    r = client.post('/api/auth/login', json={'email': email, 'password': PW[email]}, headers=H)
    assert r.status_code == 200, r.text
    return client
