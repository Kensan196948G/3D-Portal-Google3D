"""遅れの予兆：日次の記録の書き込み制限・前週比の判定・メール送信の条件と1日1回。"""
from datetime import date, timedelta

import psycopg

from .conftest import H, PW, TEST_URL, login

SVC = 'snapshot-job@portal.invalid'


def _svc(client, monkeypatch):
    monkeypatch.setenv('SNAPSHOT_EMAIL', SVC)
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        from server.security import PH
        c.execute("INSERT INTO portal.users(email, pw_hash, role) VALUES (%s,%s,'viewer') ON CONFLICT (email) DO NOTHING", (SVC, PH.hash('svc-pass-1234567890')))
    r = client.post('/api/auth/login', json={'email': SVC, 'password': 'svc-pass-1234567890'}, headers=H)
    assert r.status_code == 200
    return client


def _put(days_ago, key, delay):
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("""INSERT INTO portal.delay_snapshots(site_key, snap_date, delay_days, forecast_end) VALUES (%s,%s,%s,%s)
                     ON CONFLICT (site_key, snap_date) DO UPDATE SET delay_days=EXCLUDED.delay_days""",
                  (key, date.today() - timedelta(days=days_ago), delay, date(2027, 1, 1)))


def test_snapshot_only_service_account_from_localhost(client, monkeypatch):
    item = [{'site_key': 'tk_tokyo', 'delay_days': 5, 'forecast_end': '2027-03-01', 'actual_pct': 40, 'plan_pct': 50, 'eta': 0.9}]
    monkeypatch.setenv('SNAPSHOT_EMAIL', SVC)
    login(client, 'admin@example.com')
    assert client.post('/api/snapshots', json=item, headers=H).status_code == 403          # 管理者でも書けない
    _svc(client, monkeypatch)
    assert client.post('/api/snapshots', json=item).status_code == 403                     # CSRF のヘッダーなし
    import server.trends as tr
    monkeypatch.setattr(tr, 'LOCAL', {'127.0.0.1'})                                         # TestClient の接続元は testclient
    assert client.post('/api/snapshots', json=item, headers=H).status_code == 403          # このサーバ以外から
    monkeypatch.setattr(tr, 'LOCAL', {'testclient'})
    r = client.post('/api/snapshots', json=item, headers=H); assert r.status_code == 200, r.text
    assert client.post('/api/snapshots', json=[{**item[0], 'site_key': 'nope'}], headers=H).status_code == 400
    assert client.post('/api/snapshots', json=[{**item[0], 'eta': 'NaN'}], headers=H).status_code == 422
    monkeypatch.delenv('SNAPSHOT_EMAIL')
    assert client.post('/api/snapshots', json=item, headers=H).status_code == 403          # 未設定なら誰も書けない


def test_trend_rule_and_mail(client, monkeypatch):
    import server.trends as tr
    _put(14, 'tk_tokyo', 5); _put(8, 'tk_tokyo', 6); _put(0, 'tk_tokyo', 15)               # 8日前と比べて +9日 → 予兆
    _put(8, 'cb_nagoya', 3); _put(0, 'cb_nagoya', 4)                                       # +1日 → 予兆ではない
    _put(0, 'ks_hibiki', 30)                                                               # 比べる記録が無い → 判定しない
    login(client, 'viewer@example.com')
    t = client.get('/api/trends').json()
    s = t['sites']
    assert s['tk_tokyo']['rising'] and s['tk_tokyo']['delta'] == 9 and s['tk_tokyo']['refDelay'] == 6
    assert not s['cb_nagoya']['rising'] and s['ks_hibiki']['delta'] is None and not s['ks_hibiki']['rising']
    # メール：無効のままなら送らない
    sent = []
    r = tr.notify(sender=lambda *a: sent.append(a)); assert r['status'] == 'skipped' and 'メール通知が無効' in r['reason'] and not sent
    login(client, 'admin@example.com')
    M = {'enabled': True, 'smtpHost': 'smtp.example.invalid', 'from': 'portal@example.invalid', 'to': ['dx@example.invalid'], 'tls': False}
    assert client.put('/api/settings/mail', json=M, headers=H).status_code == 200     # 設定は項目ごと丸ごと保存（画面は全項目を送る）
    r = tr.notify(sender=lambda *a: sent.append(a)); assert 'STARTTLS' in r['reason'] and not sent      # 暗号化しない送信はしない
    client.put('/api/settings/mail', json={**M, 'tls': True, 'smtpUser': 'portal'}, headers=H)
    monkeypatch.delenv('SMTP_PASSWORD', raising=False)
    r = tr.notify(sender=lambda *a: sent.append(a)); assert 'SMTP_PASSWORD' in r['reason'] and not sent
    monkeypatch.setenv('SMTP_PASSWORD', 'not-a-real-password')
    monkeypatch.setenv('CI', 'true')
    assert tr.notify(sender=lambda *a: sent.append(a))['status'] == 'skipped' and not sent           # CI では送らない
    monkeypatch.delenv('CI')
    r = tr.notify(sender=lambda *a: sent.append(a)); assert r['status'] == 'sent' and len(sent) == 1, r
    subject, body = sent[0][1], sent[0][2]
    assert '予兆 1 件' in subject and '+9日' in body and 'not-a-real-password' not in body
    assert tr.notify(sender=lambda *a: sent.append(a))['reason'] == '今日は送信済み' and len(sent) == 1  # 1日1回まで
    with psycopg.connect(TEST_URL) as c:
        assert c.execute("SELECT status, detail FROM portal.notify_log WHERE channel='mail'").fetchone() == ('sent', None)
    # 失敗した日は同じ日に再送できる
    with psycopg.connect(TEST_URL, autocommit=True) as c:
        c.execute("UPDATE portal.notify_log SET status='failed' WHERE channel='mail'")
    def boom(*a): raise ConnectionRefusedError('refused')
    r = tr.notify(sender=boom); assert r['status'] == 'failed' and 'ConnectionRefusedError' in r['error']
    p = client.post('/api/notify/preview/mail', json={'total': 17, 'late': 0, 'warn': 0, 'lines': []}, headers=H).json()
    assert p['sent'] is False and '+9日' in p['body'] and '日次の記録' in p['note']
    client.put('/api/settings/mail', json={**M, 'enabled': False}, headers=H)
    for bad in ({'deltaDays': 0}, {'compareDays': 200}, {'deltaDays': '7'}):
        assert client.put('/api/settings/warning', json=bad, headers=H).status_code == 400, bad


def test_service_account_env_file(tmp_path):
    from server.manage import create_service_account
    env = tmp_path / '.env'; env.write_text('DATABASE_URL=x\nSNAPSHOT_PASSWORD=old\n')
    assert create_service_account(env) == SVC
    txt = env.read_text()
    assert 'DATABASE_URL=x' in txt and txt.count('SNAPSHOT_PASSWORD=') == 1 and 'SNAPSHOT_PASSWORD=old' not in txt
    assert (env.stat().st_mode & 0o777) == 0o600
    with psycopg.connect(TEST_URL) as c:
        assert c.execute('SELECT role FROM portal.users WHERE email=%s', (SVC,)).fetchone()[0] == 'viewer'
