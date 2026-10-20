-- 0002：配船計画・深浅測量の時系列・協議記録・作業区域と航路（追加のみ。削除は deleted_at による論理削除）
CREATE TABLE portal.vessel_assignments (
  id          bigserial PRIMARY KEY,
  vessel_id   text NOT NULL REFERENCES portal.vessels(id) ON DELETE RESTRICT,
  site_key    text NOT NULL REFERENCES portal.sites(key) ON DELETE RESTRICT,
  start_date  date NOT NULL,
  end_date    date NOT NULL CHECK (end_date >= start_date),
  role        text CHECK (role IS NULL OR length(role) <= 40),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_by  bigint REFERENCES portal.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX vessel_assignments_vessel_idx ON portal.vessel_assignments(vessel_id) WHERE deleted_at IS NULL;

-- 深浅測量：施工範囲の格子（T.P. の高さ dm、int16 を base64）。測量日ごとに何回でも
CREATE TABLE portal.surveys (
  id          bigserial PRIMARY KEY,
  site_key    text NOT NULL REFERENCES portal.sites(key) ON DELETE RESTRICT,
  surveyed_on date NOT NULL,
  datum       text NOT NULL CHECK (datum IN ('TP','DL')),
  dl_tp_cm    numeric(7,1),            -- DL（潮位表基準面）の T.P. からの高さ cm。datum=DL のとき必須（格子は T.P. に換算済み）
  nx          integer NOT NULL CHECK (nx BETWEEN 1 AND 200),
  nz          integer NOT NULL CHECK (nz BETWEEN 1 AND 200),
  grid        text NOT NULL CHECK (length(grid) <= 200000),
  npoints     integer NOT NULL CHECK (npoints >= 0),
  src         text CHECK (src IS NULL OR length(src) <= 120),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  uploaded_by bigint REFERENCES portal.users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CHECK (datum = 'TP' OR dl_tp_cm IS NOT NULL)
);
CREATE INDEX surveys_site_idx ON portal.surveys(site_key, surveyed_on) WHERE deleted_at IS NULL;

-- 協議記録（漁協・港湾管理者など）。出席者は組織・役職まで（個人の連絡先は書かない）
CREATE TABLE portal.consultations (
  id          bigserial PRIMARY KEY,
  site_key    text NOT NULL REFERENCES portal.sites(key) ON DELETE RESTRICT,
  held_on     date NOT NULL,
  party       text NOT NULL CHECK (party IN ('漁協','港湾管理者','海上保安部','発注者','地元','その他')),
  attendees   text CHECK (attendees IS NULL OR length(attendees) <= 300),
  summary     text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  agreements  text CHECK (agreements IS NULL OR length(agreements) <= 2000),
  followups   text CHECK (followups IS NULL OR length(followups) <= 1000),
  status      text NOT NULL DEFAULT '対応中' CHECK (status IN ('対応中','完了')),
  created_by  bigint REFERENCES portal.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX consultations_site_idx ON portal.consultations(site_key, held_on) WHERE deleted_at IS NULL;

-- 地図に重ねる線・面（作業区域・航路・漁業の区域・立入禁止など）。座標は経度・緯度（GeoJSON）
CREATE TABLE portal.map_features (
  id          bigserial PRIMARY KEY,
  site_key    text REFERENCES portal.sites(key) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('work_area','channel','fishing','restricted','other')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  geometry    jsonb NOT NULL,
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_by  bigint REFERENCES portal.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX map_features_site_idx ON portal.map_features(site_key) WHERE deleted_at IS NULL;

-- 作業船：自社・傭船の船を手で登録できるようにする（source='manual'。デモ・AIS はそのまま）
ALTER TABLE portal.vessels DROP CONSTRAINT IF EXISTS vessels_source_check;
ALTER TABLE portal.vessels ADD CONSTRAINT vessels_source_check CHECK (source IN ('demo','ais','manual'));
