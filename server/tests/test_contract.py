"""台帳の契約の項目：検証、変更契約、受注区分と JV、出典、項目ごとの確認状態（だれが・いつ）、履歴。"""
from .conftest import H, PW

LAND = {'name': '契約 試験ヤード工事', 'br': 'HK', 'port': '苫小牧港', 'client': '試験 港湾管理組合', 'ccat': '港湾管理者', 'kind': 'yard',
        'start': '2026-11-02', 'soil': 'sand', 'lon': 141.6231, 'lat': 42.6432, 'w': 120, 'd': 80, 'sea': 'E'}
CT = {'title': '令和8年度 苫小牧港 試験ふ頭ヤード整備工事', 'place': '北海道苫小牧市 港町地先', 'agency': '国土交通省 北海道開発局 室蘭開発建設部',
      'agency_no': 'R8-MR-0123', 'award_date': '2026-10-01', 'contract_date': '2026-10-08', 'period_start': '2026-10-09', 'period_end': '2027-09-30',
      'role': 'JV代表', 'jv_name': 'みらい・試験特定建設工事共同企業体', 'jv_members': ['みらい建設工業株式会社', '試験建設株式会社'],
      'sources': [{'kind': '契約書', 'title': '工事請負契約書（写し）', 'checked_on': '2026-10-10'},
                  {'kind': '公表資料', 'title': '入札結果', 'url': 'https://example.go.jp/r8/result.html'}]}


def _login(client, email):
    assert client.post('/api/auth/login', json={'email': email, 'password': PW[email]}, headers=H).status_code == 200
    return client


def _site(client, key):
    return [x for x in client.get('/api/bootstrap').json()['sites'] if x['key'] == key][0]


def test_contract_roundtrip_verify_and_history(client):
    _login(client, 'editor@example.com')
    r = client.post('/api/sites', json={**LAND, 'contract': {**CT, 'verify': {'title': True, 'period': True}}}, headers=H)
    assert r.status_code == 200, r.text
    key = r.json()['key']
    c = _site(client, key)['contract']
    assert c['title'] == CT['title'] and c['jv_members'] == CT['jv_members'] and c['sources'][1]['url'].startswith('https://')
    assert set(c['verify']) == {'title', 'period'} and c['verify']['title']['by'] == 'editor@example.com'
    first_at = c['verify']['title']['at']
    # 変更契約を足す（工期の延長）。確認は「変更」だけ増える。工事名の確認はそのまま（だれが・いつも前のまま）
    body = {**LAND, 'version': 1, 'contract': {**CT, 'changes': [{'date': '2027-03-01', 'period_end': '2027-12-28', 'note': '第1回変更（工期延長）'}],
                                                'verify': {'title': True, 'period': True, 'changes': True}}}
    _login(client, 'admin@example.com')
    r = client.put(f'/api/sites/{key}', json=body, headers=H); assert r.status_code == 200, r.text
    assert 'contract.changes' in r.json()['changed'] and 'contract.verify' in r.json()['changed']
    c = _site(client, key)['contract']
    assert c['changes'][0]['period_end'] == '2027-12-28' and c['verify']['changes']['by'] == 'admin@example.com'
    assert c['verify']['title'] == {'by': 'editor@example.com', 'at': first_at}
    # 値を変えたら、確認した人はその保存をした人になる
    body['contract'] = {**body['contract'], 'title': '令和8年度 苫小牧港 試験ふ頭ヤード整備工事（第2工区）'}; body['version'] = 2
    r = client.put(f'/api/sites/{key}', json=body, headers=H); assert r.status_code == 200
    assert _site(client, key)['contract']['verify']['title']['by'] == 'admin@example.com'
    # contract を送らない保存では契約は変わらない
    r = client.put(f'/api/sites/{key}', json={**LAND, 'name': '名前だけ', 'version': 3}, headers=H)
    assert r.json()['changed'] == ['name'] and _site(client, key)['contract']['changes']
    h = client.get(f'/api/sites/{key}/history').json()
    assert any('contract.changes' in (x['changed_fields'] or []) for x in h)


def test_contract_validation(client):
    _login(client, 'editor@example.com')
    for bad in ({'period_start': '2027-01-01', 'period_end': '2026-01-01'}, {'award_date': '2026-10-10', 'contract_date': '2026-10-01'},
                {'role': '下請'}, {'role': '単独'},                                         # 単独なのに JV がある
                {'sources': [{'kind': '噂', 'title': 'x'}]}, {'sources': [{'kind': '公表資料', 'title': 'x', 'url': 'javascript:alert(1)'}]},
                {'changes': [{'date': '2027-01-01', 'period_end': '2026-01-01'}]}, {'verify': {'secret': True}}, {'title': 'x' * 201}):
        r = client.post('/api/sites', json={**LAND, 'contract': {**CT, **bad}}, headers=H)
        assert r.status_code in (400, 422), (bad, r.status_code)
    # 空の項目は確認済みにしない・何も無ければ契約を持たない
    r = client.post('/api/sites', json={**LAND, 'contract': {'verify': {'title': True}}}, headers=H); assert r.status_code == 200
    assert 'contract' not in _site(client, r.json()['key'])
    r = client.post('/api/sites', json={**LAND, 'contract': {'role': '単独', 'verify': {'role': True, 'jv': True}}}, headers=H)
    assert set(_site(client, r.json()['key'])['contract']['verify']) == {'role'}
