-- 0003 の取り消し（検証用。本番では実行しない：日次の記録が消える）
DROP TABLE IF EXISTS portal.notify_log, portal.delay_snapshots;
DELETE FROM portal.schema_migrations WHERE version = '0003_delay_trend';
