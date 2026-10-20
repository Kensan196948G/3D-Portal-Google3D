-- 0001：みらい建設工業 3D現場ポータルの初期スキーマ（追加のみ）
CREATE SCHEMA IF NOT EXISTS portal;

CREATE TABLE portal.users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  pw_hash       text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  active        boolean NOT NULL DEFAULT true,
  failed_count  integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  pw_changed_at timestamptz NOT NULL DEFAULT now()
);

-- セッション：トークンそのものは保存せず SHA-256 だけを持つ
CREATE TABLE portal.sessions (
  token_hash   text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON portal.sessions(user_id);

-- 現場台帳（1現場＝1行。中身は online/data/sites.json の1件と同じ形）
CREATE TABLE portal.sites (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES portal.users(id)
);

-- マスタ（地域係数・潮位表地点・都道府県と高速道路の形 など）
CREATE TABLE portal.master (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 実績進捗（工程ごとの出来高 0〜1）と、その変更履歴
CREATE TABLE portal.progress (
  site_key   text NOT NULL REFERENCES portal.sites(key) ON DELETE CASCADE,
  task_idx   integer NOT NULL CHECK (task_idx >= 0 AND task_idx < 50),
  a          numeric(5,4) NOT NULL CHECK (a >= 0 AND a <= 1),
  updated_by bigint REFERENCES portal.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_key, task_idx)
);
CREATE TABLE portal.progress_history (
  id       bigserial PRIMARY KEY,
  site_key text NOT NULL,
  task_idx integer NOT NULL,
  a_old    numeric(5,4),
  a_new    numeric(5,4) NOT NULL,
  note     text CHECK (note IS NULL OR length(note) <= 500),
  user_id  bigint REFERENCES portal.users(id),
  at       timestamptz NOT NULL DEFAULT now()
);

-- 作業船の位置（demo＝架空のデモ、ais＝AIS 受信の取り込み）
CREATE TABLE portal.vessels (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  type       text NOT NULL,
  site_key   text,
  lon        double precision NOT NULL CHECK (lon BETWEEN 120 AND 155),
  lat        double precision NOT NULL CHECK (lat BETWEEN 20 AND 47),
  heading    double precision,
  speed      double precision,
  source     text NOT NULL CHECK (source IN ('demo','ais')),
  extra      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 連携の設定（秘密でない項目だけ。トークン・パスワードは server/.env）
CREATE TABLE portal.settings (
  key        text PRIMARY KEY CHECK (key IN ('neo','mail','ai')),
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES portal.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 操作の記録（ログイン・変更・設定）
CREATE TABLE portal.audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id bigint REFERENCES portal.users(id),
  action  text NOT NULL,
  detail  jsonb,
  ip      text
);
CREATE INDEX audit_log_at_idx ON portal.audit_log(at);
