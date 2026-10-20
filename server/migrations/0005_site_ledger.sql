-- 0005：現場台帳を DB の正にする（追加のみ）
-- origin：seed＝取り込み（online/data/sites.json）のまま／portal＝画面で登録・編集した（seed は上書きしない）
-- version：画面の同時編集の確認（古い版からの保存は 409）。archived_at：完了・中止（一覧から外す。消さない）
ALTER TABLE portal.sites ADD COLUMN origin text NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed','portal'));
ALTER TABLE portal.sites ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE portal.sites ADD COLUMN archived_at timestamptz;

-- 台帳の変更の履歴（その時点の全体を残す）
CREATE TABLE portal.site_history (
  id             bigserial PRIMARY KEY,
  site_key       text NOT NULL REFERENCES portal.sites(key) ON DELETE RESTRICT,
  version        integer NOT NULL,
  action         text NOT NULL CHECK (action IN ('create','update','archive','restore')),
  data           jsonb NOT NULL,
  changed_fields text[],
  user_id        bigint REFERENCES portal.users(id),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_history_site_idx ON portal.site_history(site_key, id);

-- 工事番号を固定する（これまでは画面が並び順から毎回数えていたため、登録・完了で他の現場の番号がずれる）。
-- 画面と同じ数え方：台帳の並び（seq・key）の順に、支店コード-着工年度（4月始まり）ごとに 1 から
UPDATE portal.sites s SET data = s.data || jsonb_build_object('no', x.no)
FROM (SELECT key, (data->>'br') || '-' || fy || '-' || lpad(row_number() OVER (PARTITION BY data->>'br', fy ORDER BY (data->>'seq')::int NULLS LAST, key)::text, 4, '0') AS no
      FROM (SELECT key, data, CASE WHEN split_part(data->>'start', '-', 2)::int >= 4 THEN split_part(data->>'start', '-', 1)::int
                                   ELSE split_part(data->>'start', '-', 1)::int - 1 END AS fy FROM portal.sites) t) x
WHERE s.key = x.key AND NOT (s.data ? 'no');

-- 不具合の修正：⚙ の「遅れの予兆の判定」（key＝warning）を保存できなかった
ALTER TABLE portal.settings DROP CONSTRAINT IF EXISTS settings_key_check;
ALTER TABLE portal.settings ADD CONSTRAINT settings_key_check CHECK (key IN ('neo','mail','ai','warning'));
