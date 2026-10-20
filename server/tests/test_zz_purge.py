"""架空の現場の削除（purge-sample-sites）と、架空の現場を入れない seed。最後に動かす（試験用 DB を作り直す）。"""
import psycopg
import pytest

from .conftest import TEST_URL, PW, H


@pytest.fixture
def fresh():
    from server.db import migrate
    from server.manage import seed
    from server.security import PH
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute('DROP SCHEMA IF EXISTS portal CASCADE')
    migrate(TEST_URL); seed(TEST_URL, sample=True)
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        for email, pw in [(e, p) for e, p in PW.items() if e.split('@')[0] in ('admin', 'editor', 'viewer')]:
            c.execute('INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,%s)', (email, PH.hash(pw), email.split('@')[0]))
    yield
    with psycopg.connect(TEST_URL, autocommit=True) as c:        # 後片付け：ほかのテストと同じ状態に戻す
        c.execute('DROP SCHEMA IF EXISTS portal CASCADE')
    migrate(TEST_URL); seed(TEST_URL, sample=True)
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        for email, pw in [(e, p) for e, p in PW.items() if e.split('@')[0] in ('admin', 'editor', 'viewer')]:
            c.execute('INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,%s)', (email, PH.hash(pw), email.split('@')[0]))


def _n(sql):
    with psycopg.connect(TEST_URL) as c:
        return c.execute(sql).fetchone()[0]


def test_seed_without_sample_keeps_sites_out(fresh):
    from server.manage import seed, purge_sample_sites
    assert purge_sample_sites(yes=True, url=TEST_URL)['done']
    seed(TEST_URL); seed(TEST_URL)                                       # 既定の seed は架空の現場を入れ直さない
    assert _n('SELECT count(*) FROM portal.sites') == 0 and _n('SELECT count(*) FROM portal.vessels') == 0
    assert _n("SELECT count(*) FROM portal.master WHERE key='master' AND data ? 'ledger'") == 1


def test_purge_dry_run_refusal_and_real_sites_kept(fresh, client):
    from server.manage import purge_sample_sites
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("INSERT INTO portal.delay_snapshots(site_key, snap_date, delay_days, forecast_end) VALUES ('tk_tokyo', current_date, 3, '2027-01-01')")
    r = purge_sample_sites(yes=False, url=TEST_URL)                      # 確認だけ
    assert not r['done'] and r['reason'] == 'dry-run' and r['sites'] == 17 and _n('SELECT count(*) FROM portal.sites') == 17
    # 画面で登録した現場は消さない。架空の現場に実データがあれば止まる
    assert client.post('/api/auth/login', json={'email': 'editor@example.com', 'password': PW['editor@example.com']}, headers=H).status_code == 200
    real = client.post('/api/sites', json={'name': '実際の工事', 'br': 'HK', 'port': '苫小牧港', 'client': '発注者', 'ccat': '国', 'kind': 'yard',
                                           'start': '2026-11-02', 'soil': 'sand', 'lon': 141.6231, 'lat': 42.6332, 'w': 100, 'd': 80}, headers=H).json()['key']
    client.put('/api/progress/tk_tokyo', json={'a': [1]}, headers=H)
    r = purge_sample_sites(yes=True, url=TEST_URL)
    assert not r['done'] and r['reason'] == 'dependent' and _n('SELECT count(*) FROM portal.sites') == 18
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("DELETE FROM portal.progress_history; DELETE FROM portal.progress")
    r = purge_sample_sites(yes=True, url=TEST_URL)
    assert r['done'] and r['snapshots'] == 1
    assert [k for (k,) in psycopg.connect(TEST_URL).execute('SELECT key FROM portal.sites')] == [real]
    assert _n("SELECT count(*) FROM portal.audit_log WHERE action='purge_sample_sites'") == 1
