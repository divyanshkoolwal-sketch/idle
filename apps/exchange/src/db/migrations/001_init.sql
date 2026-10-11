CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  hardware_json TEXT NOT NULL DEFAULT '{}',
  evm_address TEXT NOT NULL DEFAULT '',
  xrpl_address TEXT NOT NULL DEFAULT '',
  xrpl_public_key TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]',
  slots INTEGER NOT NULL DEFAULT 1,
  bench_embed_tps REAL NOT NULL DEFAULT 0,
  bench_gen_tps REAL NOT NULL DEFAULT 0,
  bench_json TEXT NOT NULL DEFAULT '{}',
  floors_json TEXT NOT NULL DEFAULT '{}',
  tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  strikes INTEGER NOT NULL DEFAULT 0,
  earnings_ausd TEXT NOT NULL DEFAULT '0',
  earnings_drops TEXT NOT NULL DEFAULT '0',
  jobs_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS providers_xrpl ON providers(xrpl_address);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  issue_tx TEXT,
  accept_tx TEXT,
  delete_tx TEXT,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credentials_provider ON credentials(provider_id, updated_at);

CREATE TABLE IF NOT EXISTS auctions (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  job_type TEXT NOT NULL,
  model TEXT NOT NULL,
  units INTEGER NOT NULL,
  currency TEXT NOT NULL,
  max_unit_price TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL,
  persona TEXT,
  agent_id TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  winner_provider_id TEXT,
  clearing_unit_price TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auctions_opened ON auctions(opened_at);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  eta_ms INTEGER NOT NULL,
  shade REAL,
  surge REAL,
  received_at INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS bids_auction ON bids(auction_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  auction_id TEXT,
  buyer_id TEXT,
  persona TEXT,
  job_type TEXT NOT NULL,
  model TEXT NOT NULL,
  units INTEGER NOT NULL,
  rail TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  unit_price TEXT NOT NULL DEFAULT '0',
  amount TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL DEFAULT 'AUSD',
  result_ref TEXT,
  latency_ms INTEGER,
  verify_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  auction_id TEXT,
  rail TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  payer TEXT NOT NULL DEFAULT '',
  payee TEXT NOT NULL DEFAULT '',
  payee_provider_id TEXT,
  tx_hash TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  provider_id TEXT,
  channel_id TEXT,
  buyer_address TEXT,
  buyer_pubkey TEXT,
  drops_per_token TEXT NOT NULL,
  tokens_delivered INTEGER NOT NULL DEFAULT 0,
  authorized_drops TEXT NOT NULL DEFAULT '0',
  claimed_drops TEXT NOT NULL DEFAULT '0',
  claim_tx TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  demand INTEGER,
  supply INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticks_ts ON price_ticks(ts);
