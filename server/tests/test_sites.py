"""現場台帳（DB が正）：登録・編集・完了、閲覧範囲、版の確認、変えられない変更、seed が上書きしないこと、工事番号の固定。"""
import json
import pathlib
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

from .conftest import H, TEST_URL, PW

ROOT = pathlib.Path(__file__).resolve().parents[2]
LAND = {'name': '苫小牧港 新ふ頭 試験ヤード工事', 'br': 'HK', 'port': '苫小牧港', 'client': '試験 港湾管理組合', 'ccat': '港湾管理者', 'kind': 'yard',
        'start': '2026-11-02', 'soil': 'sand', 'lon': 141.6231, 'lat': 42.6432, 'w': 120, 'd': 80, 'sea': 'E'}
MARINE = {**LAND, 'name': '試験 浚渫工事', 'kind': 'dredge', 'lon': 141.64, 'lat': 42.62, 'w': 200, 'd': 100, 'sea': None, 'design': -12.0, 'seabed': -9.5}


def _login(client, email, pw=None):
    assert client.post('/api/auth/login', json={'email': email, 'password': pw or PW[email]}, headers=H).status_code == 200
    return client


@pytest.fixture(scope='module', autouse=True)
def users():
    from server.security import PH
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("INSERT INTO portal.users(email, pw_hash, role, branches) VALUES ('kyushu-editor@example.com', %s, 'editor', '{KS}') ON CONFLICT DO NOTHING",
                  (PH.hash('ks-pass-1234567890'),))
    yield


def _app_numbers(sites):
    """画面（app.js）の数え方：台帳の並びの順に、支店-着工年度ごとに 1 から。"""
    seq, out = {}, {}
    for s in sites:
        y, m = int(s['start'][:4]), int(s['start'][5:7]); fy = y if m >= 4 else y - 1
        seq[(s['br'], fy)] = seq.get((s['br'], fy), 0) + 1
        out[s['key']] = f"{s['br']}-{fy}-{seq[(s['br'], fy)]:04d}"
    return out


def test_numbers_are_frozen_like_the_app():
    sites = json.loads((ROOT / 'online' / 'data' / 'sites.json').read_text(encoding='utf-8'))
    with psycopg.connect(TEST_URL) as c:
        got = {k: n for k, n in c.execute("SELECT key, data->>'no' FROM portal.sites WHERE origin='seed'")}
    assert {k: got[k] for k in _app_numbers(sites)} == _app_numbers(sites)


def test_create_edit_history_and_archive(client):
    _login(client, 'editor@example.com')
    r = client.post('/api/sites', json=LAND, headers=H); assert r.status_code == 200, r.text
    key, no = r.json()['key'], r.json()['no']
    assert no.startswith('HK-2026-') and key.startswith('hk_')
    s = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == key][0]
    assert s['sample'] is False and s['_version'] == 1 and s['_origin'] == 'portal' and s['no'] == no
    # 編集（版あり）→ 履歴に項目名
    r = client.put(f'/api/sites/{key}', json={**LAND, 'name': '名前を変更', 'version': 1}, headers=H); assert r.status_code == 200, r.text
    assert r.json()['changed'] == ['name'] and r.json()['version'] == 2
    assert client.put(f'/api/sites/{key}', json={**LAND, 'name': '古い版から', 'version': 1}, headers=H).status_code == 409   # 他の人の変更を上書きしない
    h = client.get(f'/api/sites/{key}/history').json()
    assert [x['action'] for x in h] == ['update', 'create'] and h[0]['changed_fields'] == ['name']
    # 着工日を4月またぎで変えても番号は変わらない
    client.put(f'/api/sites/{key}', json={**LAND, 'name': '名前を変更', 'start': '2027-05-01', 'version': 2}, headers=H)
    assert [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == key][0]['no'] == no
    # 完了：一覧・範囲から外れ、書けない。番号は再利用しない
    assert client.post(f'/api/sites/{key}/archive', json={'version': 3}, headers=H).status_code == 200
    assert key not in [x['key'] for x in client.get('/api/bootstrap').json()['sites']]
    assert client.put(f'/api/progress/{key}', json={'a': [1]}, headers=H).status_code == 404
    assert client.post('/api/consultations', json={'site_key': key, 'held_on': '2026-10-01', 'party': '漁協', 'summary': 'x'}, headers=H).status_code == 400
    r2 = client.post('/api/sites', json=LAND, headers=H)
    assert r2.json()['no'] != no
    # 戻すのは管理者だけ
    assert client.post(f'/api/sites/{key}/restore', headers=H).status_code == 403
    _login(client, 'admin@example.com')
    assert key in [x['key'] for x in client.get('/api/sites/archived').json()]
    assert client.post(f'/api/sites/{key}/restore', headers=H).status_code == 200
    assert key in [x['key'] for x in client.get('/api/bootstrap').json()['sites']]


def test_validation(client):
    _login(client, 'editor@example.com')
    for bad in ({'kind': 'castle'}, {'br': 'ZZ'}, {'soil': 'lava'}, {'ccat': '個人'}, {'sea': 'X'}, {'w': 10}, {'d': 900}, {'lon': 100},
                {'start': '1990-01-01'}, {'name': '   '}):
        assert client.post('/api/sites', json={**LAND, **bad}, headers=H).status_code in (400, 422), bad
    assert client.post('/api/sites', json={**MARINE, 'design': None}, headers=H).status_code == 400       # 海上工事は計画高が必要
    assert client.post('/api/sites', json={**MARINE, 'seabed': None}, headers=H).status_code == 400       # 仮の海底の高さが必要
    assert client.post('/api/sites', json=LAND).status_code == 403                                         # CSRF
    _login(client, 'viewer@example.com')
    assert client.post('/api/sites', json=LAND, headers=H).status_code == 403                             # 閲覧者は登録できない


def test_marine_placeholder_and_locked_grid(client):
    import base64, struct
    _login(client, 'editor@example.com')
    r = client.post('/api/sites', json=MARINE, headers=H); assert r.status_code == 200, r.text
    key = r.json()['key']
    s = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == key][0]
    sv = s['survey']
    assert (sv['nx'], sv['nz']) == (50, 25) and sv['emed'] == -9.5 and '仮の海底' in sv['src']        # 200×100 m は 4 m 刻み
    assert set(struct.unpack(f"<{(sv['nx'] + 1) * (sv['nz'] + 1)}h", base64.b64decode(sv['E']))) == {-95}
    # 測量の登録より前なら範囲を変えられる（仮の海底を作り直す）
    r = client.put(f'/api/sites/{key}', json={**MARINE, 'w': 240, 'version': 1}, headers=H); assert r.status_code == 200, r.text
    sv = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == key][0]['survey']
    assert (sv['nx'], sv['nz']) == (60, 25)
    # 深浅測量を登録したら、位置・範囲は変えられない
    n = (sv['nx'] + 1) * (sv['nz'] + 1)
    g = base64.b64encode(struct.pack(f'<{n}h', *([-100] * n))).decode()
    assert client.post('/api/surveys', json={'site_key': key, 'surveyed_on': '2026-10-01', 'datum': 'TP', 'nx': sv['nx'], 'nz': sv['nz'], 'grid': g, 'npoints': 500}, headers=H).status_code == 200
    assert client.put(f'/api/sites/{key}', json={**MARINE, 'w': 240, 'd': 120, 'version': 2}, headers=H).status_code == 409
    assert client.put(f'/api/sites/{key}', json={**MARINE, 'w': 240, 'name': '名前だけ', 'version': 2}, headers=H).status_code == 200
    # 台帳の測量（架空）がある既存の海上工事も、範囲は変えられない
    b = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == 'tk_tokyo_dredge'][0]
    body = {f: b.get(f) for f in ('name', 'br', 'port', 'client', 'ccat', 'kind', 'start', 'soil', 'lon', 'lat', 'w', 'd', 'sea', 'design')}
    assert client.put('/api/sites/tk_tokyo_dredge', json={**body, 'w': b['w'] + 20, 'version': b['_version']}, headers=H).status_code == 409


def test_kind_change_blocked_with_progress(client):
    _login(client, 'editor@example.com')
    key = client.post('/api/sites', json=LAND, headers=H).json()['key']
    assert client.put(f'/api/progress/{key}', json={'a': [1, 0.2]}, headers=H).status_code == 200
    assert client.put(f'/api/sites/{key}', json={**LAND, 'kind': 'road', 'version': 1}, headers=H).status_code == 409


def test_branch_scope(client):
    _login(client, 'kyushu-editor@example.com', 'ks-pass-1234567890')
    assert client.post('/api/sites', json=LAND, headers=H).status_code == 404                              # 範囲外の支店には登録できない
    r = client.post('/api/sites', json={**LAND, 'br': 'KS', 'port': '博多港'}, headers=H); assert r.status_code == 200
    key = r.json()['key']
    assert client.put(f'/api/sites/{key}', json={**LAND, 'version': 1}, headers=H).status_code == 404      # 範囲外の支店へは移せない
    assert client.put('/api/sites/hk_tomakomai', json={**LAND, 'version': 1}, headers=H).status_code == 404
    assert client.get('/api/sites/hk_tomakomai/history').status_code == 404
    assert client.post('/api/sites/hk_tomakomai/archive', json={'version': 1}, headers=H).status_code == 404


def test_seed_keeps_portal_edits_and_archives(client):
    from server.manage import seed
    _login(client, 'admin@example.com')
    b = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == 'cb_shimizu'][0]
    body = {f: b.get(f) for f in ('name', 'br', 'port', 'client', 'ccat', 'kind', 'start', 'soil', 'lon', 'lat', 'w', 'd', 'sea')}
    assert client.put('/api/sites/cb_shimizu', json={**body, 'client': '画面で直した発注者', 'version': b['_version']}, headers=H).status_code == 200
    seed(TEST_URL); seed(TEST_URL)
    after = [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == 'cb_shimizu'][0]
    assert after['client'] == '画面で直した発注者' and after['_origin'] == 'portal' and after['no'] == b['no']
    with psycopg.connect(TEST_URL) as c:
        assert c.execute("SELECT count(*) FROM portal.sites WHERE NOT (data ? 'no')").fetchone()[0] == 0


def test_concurrent_creates_get_distinct_numbers():
    from fastapi.testclient import TestClient
    from server.app import app
    def one(i):
        c = _login(TestClient(app), 'editor@example.com')
        return c.post('/api/sites', json={**LAND, 'name': f'同時 {i}', 'start': '2030-06-01'}, headers=H).json()['no']
    with ThreadPoolExecutor(6) as ex:
        nos = list(ex.map(one, range(6)))
    assert len(set(nos)) == 6 and all(n.startswith('HK-2030-') for n in nos)


def test_settings_warning_can_be_saved(client):
    _login(client, 'admin@example.com')
    assert client.put('/api/settings/warning', json={'compareDays': 7, 'deltaDays': 5}, headers=H).status_code == 200
    assert client.get('/api/settings').json()['warning']['deltaDays'] == 5
