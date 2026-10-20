"""運用データの検査：配船計画（重なり）・深浅測量・協議記録・区域、権限・CSRF・論理削除・監査ログ・取り込み直し。"""
import base64
import json
import struct

import psycopg

from .conftest import H, TEST_URL, login

DREDGE = 'tk_tokyo_dredge'


def _grid(site_key=DREDGE, value_dm=-110):
    with psycopg.connect(TEST_URL) as c:
        sv = c.execute('SELECT data->\'survey\' FROM portal.sites WHERE key=%s', (site_key,)).fetchone()[0]
    n = (sv['nx'] + 1) * (sv['nz'] + 1)
    return sv['nx'], sv['nz'], base64.b64encode(struct.pack(f'<{n}h', *([value_dm] * n))).decode()


def _audit_texts():
    with psycopg.connect(TEST_URL) as c:
        return [json.dumps(r[0], ensure_ascii=False) for r in c.execute("SELECT detail FROM portal.audit_log WHERE action LIKE 'consultation%%'")]


def test_viewer_cannot_write_and_csrf(client):
    for p in ('/api/operations', '/api/surveys/1'):
        assert client.get(p).status_code == 401, p
    login(client, 'viewer@example.com')
    ops = client.get('/api/operations').json()
    assert {'assignments', 'surveys', 'consultations', 'mapFeatures', 'vessels'} <= set(ops)
    body = {'vessel_id': 'V01', 'site_key': 'tk_tokyo', 'start_date': '2026-11-01', 'end_date': '2026-11-10'}
    assert client.post('/api/assignments', json=body, headers=H).status_code == 403
    assert client.post('/api/consultations', json={'site_key': 'tk_tokyo', 'held_on': '2026-10-01', 'party': '漁協', 'summary': 'x'}, headers=H).status_code == 403
    login(client, 'editor@example.com')
    assert client.post('/api/assignments', json=body).status_code == 403          # CSRF のヘッダーなし
    assert client.post('/api/vessels/manual', json={'name': 'x', 'type': 'grab', 'site_key': 'tk_tokyo'}, headers=H).status_code == 403   # 管理者だけ


def test_assignment_overlap_and_update(client):
    login(client, 'editor@example.com')
    a = {'vessel_id': 'V02', 'site_key': 'tk_tokyo', 'start_date': '2027-01-01', 'end_date': '2027-01-31', 'role': '土砂運搬'}
    r = client.post('/api/assignments', json=a, headers=H); assert r.status_code == 200, r.text
    aid = r.json()['id']
    clash = client.post('/api/assignments', json={**a, 'site_key': DREDGE, 'start_date': '2027-01-31', 'end_date': '2027-02-10'}, headers=H)
    assert clash.status_code == 409 and clash.json()['conflicts'][0]['id'] == aid        # 両端の日を含めて重なりとみなす
    assert client.post('/api/assignments', json={**a, 'start_date': '2027-02-01', 'end_date': '2027-02-10'}, headers=H).status_code == 200
    assert client.put(f'/api/assignments/{aid}', json={**a, 'note': '日付は変えない'}, headers=H).status_code == 200   # 自分自身とは重ならない
    assert client.post('/api/assignments', json={**a, 'start_date': '2027-03-10', 'end_date': '2027-03-01'}, headers=H).status_code == 400
    assert client.post('/api/assignments', json={**a, 'vessel_id': 'NOPE'}, headers=H).status_code == 400
    assert client.post('/api/assignments', json={**a, 'site_key': 'no_such_site'}, headers=H).status_code == 400
    assert client.delete(f'/api/assignments/{aid}', headers=H).status_code == 200
    ids = [x['id'] for x in client.get('/api/bootstrap').json()['assignments']]
    assert aid not in ids                                                                  # 論理削除は一覧から消える
    assert client.post('/api/assignments', json=a, headers=H).status_code == 200            # 消した後は同じ期間に入れられる


def test_seed_keeps_assignments(client):
    from server.manage import seed
    login(client, 'editor@example.com')
    r = client.post('/api/assignments', json={'vessel_id': 'V07', 'site_key': DREDGE, 'start_date': '2028-01-01', 'end_date': '2028-01-05'}, headers=H)
    assert r.status_code == 200, r.text
    seed(TEST_URL, sample=True); seed(TEST_URL, sample=True)
    assert r.json()['id'] in [x['id'] for x in client.get('/api/bootstrap').json()['assignments']]


def test_manual_vessel(client):
    login(client, 'admin@example.com')
    r = client.post('/api/vessels/manual', json={'name': '自社 グラブ船 第一みらい丸', 'type': 'grab', 'site_key': DREDGE, 'len': 48}, headers=H)
    assert r.status_code == 200, r.text
    v = [x for x in client.get('/api/bootstrap').json()['vessels'] if x['id'] == r.json()['id']][0]
    assert v['source'] == 'manual' and v['radius'] == 0
    assert client.post('/api/vessels/manual', json={'name': 'x', 'type': 'submarine', 'site_key': DREDGE}, headers=H).status_code == 400
    assert client.post('/api/vessels/manual', json={'name': '   ', 'type': 'grab', 'site_key': DREDGE}, headers=H).status_code == 400   # 空白だけの名前


def test_survey_upload_and_validation(client):
    login(client, 'editor@example.com')
    nx, nz, g = _grid()
    base = {'site_key': DREDGE, 'surveyed_on': '2026-09-15', 'datum': 'TP', 'nx': nx, 'nz': nz, 'grid': g, 'npoints': 1200, 'src': 'test.xyz'}
    r = client.post('/api/surveys', json=base, headers=H); assert r.status_code == 200, r.text
    sid = r.json()['id']
    got = client.get(f'/api/surveys/{sid}').json(); assert got['grid'] == g and got['surveyed_on'] == '2026-09-15'
    assert client.post('/api/surveys', json={**base, 'nx': nx - 1}, headers=H).status_code == 400                  # 格子の大きさが違う
    assert client.post('/api/surveys', json={**base, 'grid': g[:-8]}, headers=H).status_code == 400               # 点の数が違う
    assert client.post('/api/surveys', json={**base, 'site_key': 'tk_tokyo'}, headers=H).status_code == 400       # 陸上の現場
    assert client.post('/api/surveys', json={**base, 'datum': 'DL'}, headers=H).status_code == 400                # DL の標高なし
    assert client.post('/api/surveys', json={**base, 'datum': 'DL', 'dl_tp_cm': 'NaN'}, headers=H).status_code in (400, 422)
    assert client.post('/api/surveys', json={**base, 'datum': 'DL', 'dl_tp_cm': -113.5}, headers=H).status_code == 200
    assert client.post('/api/surveys', json={**base, 'surveyed_on': '2099-01-01'}, headers=H).status_code == 400
    _, _, far = _grid(value_dm=-2000)
    assert client.post('/api/surveys', json={**base, 'grid': far}, headers=H).status_code == 400                  # T.P. -200m は範囲外
    meta = [s for s in client.get('/api/bootstrap').json()['surveys'] if s['id'] == sid][0]
    assert 'grid' not in meta and meta['nx'] == nx
    assert client.delete(f'/api/surveys/{sid}', headers=H).status_code == 200
    assert client.get(f'/api/surveys/{sid}').status_code == 404


def test_consultation_pii_and_audit(client):
    login(client, 'editor@example.com')
    c = {'site_key': DREDGE, 'held_on': '2026-10-01', 'party': '漁協', 'attendees': 'サンプル漁協 組合長・理事2名／当社 所長',
         'summary': '浚渫土の運搬航路と操業時間の調整（秘密の本文）', 'agreements': '8時〜16時は北側航路を使わない', 'followups': '航路図を送る'}
    r = client.post('/api/consultations', json=c, headers=H); assert r.status_code == 200, r.text
    cid = r.json()['id']
    for bad in ('連絡先 090-1234-5678', 'tanaka@example.co.jp', '組合長（携帯０９０－１２３４－５６７８）', '電話0312345678まで', '事務所 03(1234)5678',
                'ｔａｎａｋａ＠ｅｘａｍｐｌｅ．ｊｐ', '組合長 090ー1234ー5678'):
        assert client.post('/api/consultations', json={**c, 'attendees': bad}, headers=H).status_code == 400
    for ok in ('令和8年10月1日 第2回 8時〜16時', '水深 -12.0m・2026-10-01 の測量', '漁船 30隻'):   # 日付・数値は通す
        assert client.post('/api/consultations', json={**c, 'summary': ok}, headers=H).status_code == 200, ok
    assert client.post('/api/consultations', json={**c, 'party': '国会'}, headers=H).status_code == 400
    assert client.post('/api/consultations', json={**c, 'summary': '　 '}, headers=H).status_code == 400
    assert client.put(f'/api/consultations/{cid}', json={**c, 'status': '完了'}, headers=H).status_code == 200
    assert [x['status'] for x in client.get('/api/bootstrap').json()['consultations'] if x['id'] == cid] == ['完了']
    assert not any('秘密の本文' in t or '組合長' in t for t in _audit_texts())                        # 本文・出席者は監査ログに写さない
    assert client.delete(f'/api/consultations/{cid}', headers=H).status_code == 200
    assert cid not in [x['id'] for x in client.get('/api/bootstrap').json()['consultations']]


def test_map_features(client):
    login(client, 'editor@example.com')
    poly = {'type': 'Polygon', 'coordinates': [[[139.778, 35.595], [139.781, 35.595], [139.781, 35.597], [139.778, 35.597]]]}
    r = client.post('/api/map-features', json={'site_key': DREDGE, 'kind': 'work_area', 'name': '浚渫の作業区域', 'geometry': poly}, headers=H)
    assert r.status_code == 200, r.text
    ring = r.json()['geometry']['coordinates'][0]; assert ring[0] == ring[-1] and len(ring) == 5     # 外周を閉じる
    line = {'type': 'LineString', 'coordinates': [[139.77, 35.59], [139.79, 35.60]]}
    assert client.post('/api/map-features', json={'site_key': DREDGE, 'kind': 'channel', 'name': '航路（手入力）', 'geometry': line}, headers=H).status_code == 200
    raw = '{"site_key": "%s", "kind": "other", "name": "x", "geometry": {"type": "LineString", "coordinates": [[139.77, 35.59], [NaN, 35.6]]}}' % DREDGE
    assert client.post('/api/map-features', content=raw, headers={**H, 'Content-Type': 'application/json'}).status_code == 400   # JSON の NaN（Python では読めてしまう）
    for g in ({'type': 'LineString', 'coordinates': [[0, 0], [1, 1]]},
              {'type': 'LineString', 'coordinates': [[139.77, 35.59], [140.5, 35.60]]},       # 現場から 30km 以上
              {'type': 'Point', 'coordinates': [139.77, 35.59]}):
        assert client.post('/api/map-features', json={'site_key': DREDGE, 'kind': 'other', 'name': 'x', 'geometry': g}, headers=H).status_code == 400, g
    assert client.post('/api/map-features', json={'site_key': DREDGE, 'kind': 'secret', 'name': 'x', 'geometry': line}, headers=H).status_code == 400
    assert client.post('/api/map-features', json={'site_key': DREDGE, 'kind': 'other', 'name': '  ', 'geometry': line}, headers=H).status_code == 400
