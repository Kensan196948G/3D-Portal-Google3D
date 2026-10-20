-- 0004：支店ごとの閲覧範囲（追加のみ）
-- branches：見られる支店のコード（sites.data->>'br'。例 {HK,TH}）。NULL＝全支店（既存の利用者はこれまでどおり全社を見る）。
-- 空の配列＝どの支店も見られない（「全社」と取り違えないよう、NULL と区別する）。管理者は設定が全社にかかわるため常に全支店
ALTER TABLE portal.users ADD COLUMN branches text[];
ALTER TABLE portal.users ADD CONSTRAINT users_branches_check
  CHECK (branches IS NULL OR (array_position(branches, NULL) IS NULL AND (role <> 'admin')));
