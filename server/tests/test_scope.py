"""支店ごとの閲覧範囲：範囲外の現場は一覧に出ず、ID・キーで直接たどっても「見つからない」（404）。配船は他支店を伏せて返す。"""
import base64
import struct

import psycopg
import pytest

from .conftest import H, TEST_URL, PW

HK = {'hk_tomakomai', 'hk_ishikari'}
OUT = 'tk_tokyo'
DREDGE = 'tk_tokyo_dredge'
SCOPED = {'hk-editor@example.com': ('editor', ['HK']), 'none-viewer@example.com': ('viewer', [])}


@pytest.fixture(scope='module', autouse=True)
def scoped_users():
    from server.security import PH
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        for e, (r, b) in SCOPED.items():
            c.execute('INSERT INTO portal.users(email, pw_hash, role, branches) VALUES (%s,%s,%s,%s) ON CONFLICT (email) DO NOTHING',
                      (e, PH.hash('scoped-pass-123456'), r, b))
    yield


def _login(client, email):
    pw = PW.get(email, 'scoped-pass-123456')
    assert client.post('/api/auth/login', json={'email': email, 'password': pw}, headers=H).status_code == 200
    return client


def _grid():
    with psycopg.connect(TEST_URL) as c:
        sv = c.execute("SELECT data->'survey' FROM portal.sites WHERE key=%s", (DREDGE,)).fetchone()[0]
    n = (sv['nx'] + 1) * (sv['nz'] + 1)
    return sv['nx'], sv['nz'], base64.b64encode(struct.pack(f'<{n}h', *([-110] * n))).decode()


@pytest.fixture(scope='module')
def others():
    """管理者が範囲外（東京）の現場に作ったデータ。"""
    from fastapi.testclient import TestClient
    from server.app import app
    a = _login(TestClient(app), 'admin@example.com')
    nx, nz, g = _grid()
    ids = {
        'survey': a.post('/api/surveys', json={'site_key': DREDGE, 'surveyed_on': '2026-09-01', 'datum': 'TP', 'nx': nx, 'nz': nz, 'grid': g, 'npoints': 100}, headers=H).json()['id'],
        'asg': a.post('/api/assignments', json={'vessel_id': 'V03', 'site_key': OUT, 'start_date': '2029-01-01', 'end_date': '2029-01-31', 'role': '他支店の役割', 'note': '他支店のメモ'}, headers=H).json()['id'],
        'con': a.post('/api/consultations', json={'site_key': OUT, 'held_on': '2026-10-01', 'party': '漁協', 'summary': '他支店の協議（見えてはいけない）'}, headers=H).json()['id'],
        'fea': a.post('/api/map-features', json={'site_key': OUT, 'kind': 'work_area', 'name': '他支店の区域',
                                                 'geometry': {'type': 'LineString', 'coordinates': [[139.77, 35.59], [139.78, 35.60]]}}, headers=H).json()['id'],
    }
    a.put('/api/progress/' + OUT, json={'a': [1, 0.5]}, headers=H)
    return ids


def test_bootstrap_is_filtered(client, others):
    b = _login(client, 'hk-editor@example.com').get('/api/bootstrap').json()
    assert {s['key'] for s in b['sites']} == HK and b['user']['branches'] == ['HK']
    assert set(b['progress']) <= HK
    assert all(v['site'] in HK or v['site'] is None for v in b['vessels']) and len(b['vessels']) >= 7       # 船は共有、所属は伏せる
    masked = [a for a in b['assignments'] if a.get('masked')]
    assert masked and all(a['site_key'] is None and a['role'] is None and a['note'] is None and a['id'] is None for a in masked)
    assert not [x for x in b['surveys'] + b['consultations'] if x['site_key'] not in HK]
    assert not [f for f in b['mapFeatures'] if f['site_key'] not in HK and f['site_key'] is not None]
    assert '他支店の協議' not in str(b) and '他支店のメモ' not in str(b) and '他支店の役割' not in str(b)
    o = client.get('/api/operations').json()
    assert '他支店の協議' not in str(o) and all(v['site'] in HK or v['site'] is None for v in o['vessels'])


def test_empty_scope_sees_nothing(client, others):
    b = _login(client, 'none-viewer@example.com').get('/api/bootstrap').json()
    assert b['sites'] == [] and b['progress'] == {} and b['surveys'] == [] and b['consultations'] == [] and b['user']['branches'] == []
    assert client.get('/api/trends').json()['sites'] == {}


def test_out_of_scope_is_not_found(client, others):
    _login(client, 'hk-editor@example.com')
    asg = {'vessel_id': 'V05', 'site_key': OUT, 'start_date': '2030-01-01', 'end_date': '2030-01-10'}
    con = {'site_key': OUT, 'held_on': '2026-10-01', 'party': '漁協', 'summary': 'x'}
    line = {'type': 'LineString', 'coordinates': [[139.77, 35.59], [139.78, 35.60]]}
    for m, url, body in (('get', f'/api/progress/{OUT}/history', None), ('put', f'/api/progress/{OUT}', {'a': [1]}), ('delete', f'/api/progress/{OUT}', None),
                         ('get', f"/api/surveys/{others['survey']}", None), ('delete', f"/api/surveys/{others['survey']}", None),
                         ('post', '/api/assignments', asg), ('put', f"/api/assignments/{others['asg']}", {**asg, 'site_key': 'hk_tomakomai'}),
                         ('delete', f"/api/assignments/{others['asg']}", None),
                         ('post', '/api/consultations', con), ('put', f"/api/consultations/{others['con']}", {**con, 'site_key': 'hk_tomakomai'}),
                         ('delete', f"/api/consultations/{others['con']}", None),
                         ('post', '/api/map-features', {'site_key': OUT, 'kind': 'other', 'name': 'x', 'geometry': line}),
                         ('post', '/api/map-features', {'kind': 'other', 'name': '全社共通', 'geometry': line}),
                         ('delete', f"/api/map-features/{others['fea']}", None)):
        r = getattr(client, m)(url, **({'json': body} if body is not None else {}), headers=H)
        assert r.status_code == 404, (m, url, r.status_code, r.text)
    # 存在しない現場も、範囲外と同じ 404（400 との差で他支店の現場の有無を推測させない）
    ghost = 'no_such_site'
    for url, body in (('/api/assignments', {**asg, 'site_key': ghost}), ('/api/consultations', {**con, 'site_key': ghost}),
                      ('/api/map-features', {'site_key': ghost, 'kind': 'other', 'name': 'x', 'geometry': line}),
                      ('/api/surveys', {'site_key': ghost, 'surveyed_on': '2026-09-01', 'datum': 'TP', 'nx': 1, 'nz': 1, 'grid': 'AAAAAAAAAAA=', 'npoints': 20}),
                      (f'/api/progress/{ghost}', {'a': [1]})):
        r = (client.put if 'progress' in url else client.post)(url, json=body, headers=H)
        assert r.status_code == 404, (url, r.status_code, r.text)
    assert client.put(f"/api/consultations/{others['con']}", json={**con, 'site_key': ghost}, headers=H).status_code == 404
    # 自支店の現場には書ける
    assert client.post('/api/consultations', json={**con, 'site_key': 'hk_tomakomai'}, headers=H).status_code == 200
    assert client.put('/api/progress/hk_tomakomai', json={'a': [1]}, headers=H).status_code == 200
    with psycopg.connect(TEST_URL) as c:     # 範囲外のデータは消えていない
        assert c.execute('SELECT deleted_at FROM portal.consultations WHERE id=%s', (others['con'],)).fetchone()[0] is None


def test_conflict_with_other_branch_is_masked(client, others):
    _login(client, 'hk-editor@example.com')
    r = client.post('/api/assignments', json={'vessel_id': 'V03', 'site_key': 'hk_tomakomai', 'start_date': '2029-01-15', 'end_date': '2029-02-10'}, headers=H)
    assert r.status_code == 409
    c = r.json()['conflicts'][0]
    assert c['site_key'] is None and c['id'] is None and c['masked'] and c['start_date'] == '2029-01-01'


def test_admin_and_legacy_users_see_all(client, others):
    assert len(_login(client, 'admin@example.com').get('/api/bootstrap').json()['sites']) == 17
    assert len(_login(client, 'viewer@example.com').get('/api/bootstrap').json()['sites']) == 17     # 既存（branches が NULL）は全支店


def test_admin_cannot_have_branches():
    with psycopg.connect(TEST_URL, autocommit=True) as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute("UPDATE portal.users SET branches='{HK}' WHERE email='admin@example.com'")


def test_every_api_route_is_scoped_or_global():
    """新しい API を足したとき、閲覧範囲の確認を忘れないための一覧。"""
    from server.app import app
    GLOBAL = {'/api/auth/me', '/api/auth/login', '/api/auth/logout', '/api/auth/password', '/api/settings', '/api/settings/{key}',
              '/api/notify/preview/{channel}', '/api/ais/ingest', '/api/ai/explain', '/api/vessels', '/api/vessels/manual',
              '/api/sites/archived', '/api/sites/{key}/restore'}     # 管理者だけ（全支店）
    SCOPED_ROUTES = {'/api/bootstrap', '/api/operations', '/api/trends', '/api/progress/{site_key}', '/api/progress/{site_key}/history',
                     '/api/surveys', '/api/surveys/{sid}', '/api/assignments', '/api/assignments/{aid}', '/api/consultations',
                     '/api/consultations/{cid}', '/api/map-features', '/api/map-features/{fid}',
                     '/api/sites', '/api/sites/{key}', '/api/sites/{key}/archive', '/api/sites/{key}/history'}
    paths = {r.path for r in app.routes if getattr(r, 'path', '').startswith('/api/')}
    assert paths - GLOBAL - SCOPED_ROUTES == set(), '閲覧範囲の扱いが決まっていない API があります'


def test_cli_branch_parsing():
    from server.manage import parse_branches
    assert parse_branches('hk, th', 'viewer', TEST_URL) == ['HK', 'TH'] and parse_branches('all', 'editor', TEST_URL) is None
    assert parse_branches('none', 'viewer', TEST_URL) == []
    for spec, role in ((None, 'viewer'), ('ZZ', 'viewer'), ('HK', 'admin'), (',', 'editor')):
        with pytest.raises(SystemExit):
            parse_branches(spec, role, TEST_URL)
