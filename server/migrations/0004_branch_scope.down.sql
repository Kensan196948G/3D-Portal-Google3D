-- 0004 の取り消し（検証用。支店の割り当てが消え、全員が全社を見られる状態に戻る）
ALTER TABLE portal.users DROP CONSTRAINT IF EXISTS users_branches_check;
ALTER TABLE portal.users DROP COLUMN IF EXISTS branches;
DELETE FROM portal.schema_migrations WHERE version = '0004_branch_scope';
