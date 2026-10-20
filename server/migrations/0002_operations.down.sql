-- 0002 の取り消し（検証用。本番では実行前にバックアップを取ること。手で登録した作業船も消える）
DROP TABLE IF EXISTS portal.map_features, portal.consultations, portal.surveys, portal.vessel_assignments;
DELETE FROM portal.vessels WHERE source = 'manual';
ALTER TABLE portal.vessels DROP CONSTRAINT IF EXISTS vessels_source_check;
ALTER TABLE portal.vessels ADD CONSTRAINT vessels_source_check CHECK (source IN ('demo','ais'));
DELETE FROM portal.schema_migrations WHERE version = '0002_operations';
