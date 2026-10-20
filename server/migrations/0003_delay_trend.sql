-- 0003：遅れの予兆（日次の記録と通知の記録）。追加のみ
-- 日次の記録：正式な予測（初期計画の編成＋実績で較正した実効率＝画面の s.base）を、毎朝の定時処理（専用アカウント）が1現場1日1行で保存する
CREATE TABLE portal.delay_snapshots (
  site_key     text NOT NULL REFERENCES portal.sites(key) ON DELETE RESTRICT,
  snap_date    date NOT NULL,
  delay_days   integer NOT NULL CHECK (delay_days BETWEEN -3650 AND 3650),
  forecast_end date NOT NULL,
  actual_pct   numeric(5,1) CHECK (actual_pct BETWEEN 0 AND 100),
  plan_pct     numeric(5,1) CHECK (plan_pct BETWEEN 0 AND 100),
  eta          numeric(6,3) CHECK (eta BETWEEN 0 AND 10),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_key, snap_date)
);
CREATE INDEX delay_snapshots_date_idx ON portal.delay_snapshots(snap_date);

-- 通知の記録：同じ通知先へは1日1回まで（UNIQUE）。本文・宛先のアドレス・秘密情報は残さない
CREATE TABLE portal.notify_log (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('mail','neo')),
  sent_on     date NOT NULL,
  status      text NOT NULL CHECK (status IN ('sending','sent','failed')),
  recipients  integer,
  rising      integer,
  detail      text CHECK (detail IS NULL OR length(detail) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, sent_on)
);
