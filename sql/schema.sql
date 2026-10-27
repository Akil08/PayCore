CREATE EXTENSION IF NOT EXISTS pgcrypto;


CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','analyst')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid UNIQUE REFERENCES users(id),
  type       text NOT NULL CHECK (type IN ('user','external_bank','in_transit')),
  balance    bigint NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','blacklisted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'user' OR balance >= 0)
);


INSERT INTO accounts (id, user_id, type, balance, status) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'external_bank', 0, 'active'),
  ('00000000-0000-0000-0000-000000000002', NULL, 'in_transit',    0, 'active')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_account_id   uuid NOT NULL REFERENCES accounts(id),
  receiver_account_id uuid NOT NULL REFERENCES accounts(id),
  amount              bigint NOT NULL CHECK (amount > 0),
  status              text NOT NULL CHECK (status IN ('held','settled','expired','declined')),
  failed_check        text,
  idempotency_key     text NOT NULL,
  payload_hash        text NOT NULL,
  device_id           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ledger (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  amount      bigint NOT NULL CHECK (amount <> 0),
  transfer_id uuid REFERENCES transfers(id),
  reason      text NOT NULL CHECK (reason IN ('deposit','withdrawal','hold','settle','refund')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id         bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

CREATE TABLE IF NOT EXISTS processed_events (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS user_stats (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id),
  txn_count    bigint NOT NULL DEFAULT 0,
  total_amount bigint NOT NULL DEFAULT 0,
  avg_amount   bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_devices (
  account_id uuid NOT NULL REFERENCES accounts(id),
  device_id  text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_id)
);

CREATE TABLE IF NOT EXISTS account_clusters (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id),
  cluster_id   uuid NOT NULL,
  cluster_size int  NOT NULL,
  flagged      boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS signals (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind       text NOT NULL CHECK (kind IN ('velocity','amount_anomaly','cluster','repeat_declines')),
  severity   int  NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_flag_log (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  action     text NOT NULL CHECK (action IN ('freeze','unfreeze','blacklist','unblacklist')),
  reason     text,
  set_by     text NOT NULL CHECK (set_by IN ('analyzer','analyst')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id          bigserial PRIMARY KEY,
  queue       text NOT NULL,
  payload     jsonb NOT NULL,
  error       text,
  attempts    int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz
);

CREATE TABLE IF NOT EXISTS recon_runs (
  id                  bigserial PRIMARY KEY,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  ledger_sum          bigint NOT NULL,
  mismatched_accounts int    NOT NULL,
  in_transit_ok       boolean NOT NULL,
  stuck_holds         int    NOT NULL,
  passed              boolean NOT NULL
);

-- Indexes (the fast inline path depends on these)
CREATE INDEX IF NOT EXISTS transfers_sender_created   ON transfers (sender_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_receiver_created ON transfers (receiver_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_created          ON transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_held_created     ON transfers (created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS ledger_account_id_desc     ON ledger (account_id, id DESC);
CREATE INDEX IF NOT EXISTS ledger_transfer            ON ledger (transfer_id);
CREATE INDEX IF NOT EXISTS outbox_pending             ON outbox (id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS account_devices_device     ON account_devices (device_id);
CREATE INDEX IF NOT EXISTS account_clusters_cluster   ON account_clusters (cluster_id);
CREATE INDEX IF NOT EXISTS signals_account_created    ON signals (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signals_created            ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS flag_log_account_created   ON account_flag_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dead_letters_open          ON dead_letters (id) WHERE replayed_at IS NULL;