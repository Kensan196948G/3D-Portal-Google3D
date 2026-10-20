-- 0005 の取り消し（検証用。本番では実行しない：画面で登録した現場の区別・履歴・完了の印が消える）
DELETE FROM portal.settings WHERE key = 'warning';
ALTER TABLE portal.settings DROP CONSTRAINT IF EXISTS settings_key_check;
ALTER TABLE portal.settings ADD CONSTRAINT settings_key_check CHECK (key IN ('neo','mail','ai'));
DROP TABLE IF EXISTS portal.site_history;
ALTER TABLE portal.sites DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS version, DROP COLUMN IF EXISTS origin;
UPDATE portal.sites SET data = data - 'no';
DELETE FROM portal.schema_migrations WHERE version = '0005_site_ledger';
