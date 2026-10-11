import type { DB } from './index';

export interface ProviderRow {
  id: string;
  name: string;
  region: string;
  hardware_json: string;
  evm_address: string;
  xrpl_address: string;
  xrpl_public_key: string;
  models_json: string;
  slots: number;
  bench_embed_tps: number;
  bench_gen_tps: number;
  bench_json: string;
  floors_json: string;
  tier: string | null;
  status: string;
  strikes: number;
  earnings_ausd: string;
  earnings_drops: string;
  jobs_done: number;
  created_at: number;
  last_seen: number | null;
}
export interface CredentialRow {
  id: string;
  provider_id: string;
  credential_type: string;
  issue_tx: string | null;
  accept_tx: string | null;
  delete_tx: string | null;
  status: string;
  updated_at: number;
}
export interface AuctionRow {
  id: string;
  job_id: string | null;
  job_type: string;
  model: string;
  units: number;
  currency: string;
  max_unit_price: string;
  deadline_ms: number;
  persona: string | null;
  agent_id: string | null;
  opened_at: number;
  closed_at: number | null;
  winner_provider_id: string | null;
  clearing_unit_price: string | null;
  status: string;
}
export interface BidRow {
  id: string;
  auction_id: string;
  provider_id: string;
  unit_price: string;
  eta_ms: number;
  shade: number | null;
  surge: number | null;
  received_at: number;
  valid: number;
  reason: string | null;
}
export interface JobRow {
  id: string;
  auction_id: string | null;
  buyer_id: string | null;
  persona: string | null;
  job_type: string;
  model: string;
  units: number;
  rail: string;
  status: string;
  provider_id: string | null;
  unit_price: string;
  amount: string;
  currency: string;
  result_ref: string | null;
  latency_ms: number | null;
  verify_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export interface PaymentRow {
  id: string;
  job_id: string;
  auction_id: string | null;
  rail: string;
  currency: string;
  amount_atomic: string;
  payer: string;
  payee: string;
  payee_provider_id: string | null;
  tx_hash: string | null;
  status: string;
  reason: string | null;
  created_at: number;
}
export interface StreamRow {
  id: string;
  job_id: string;
  provider_id: string | null;
  channel_id: string | null;
  buyer_address: string | null;
  buyer_pubkey: string | null;
  drops_per_token: string;
  tokens_delivered: number;
  authorized_drops: string;
  claimed_drops: string;
  claim_tx: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}
export interface AgentLogRow {
  id: number;
  agent_id: string;
  persona: string;
  kind: string;
  text: string;
  meta_json: string | null;
  created_at: number;
}
export interface TickRow {
  id: number;
  job_type: string;
  currency: string;
  unit_price: string;
  demand: number | null;
  supply: number | null;
  ts: number;
}

const cols = <T extends object>(row: T) => Object.keys(row);

export class Repo {
  constructor(public db: DB) {}

  private upsert<T extends object>(table: string, row: T): void {
    const keys = cols(row);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})
      ON CONFLICT(id) DO UPDATE SET ${keys.filter((k) => k !== 'id').map((k) => `${k}=excluded.${k}`).join(',')}`;
    this.db.prepare(sql).run(row);
  }
  private update(table: string, id: string, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...patch, id });
  }

  // providers
  upsertProvider(row: ProviderRow): void {
    this.upsert('providers', row);
  }
  updateProvider(id: string, patch: Partial<ProviderRow>): void {
    this.update('providers', id, patch);
  }
  getProvider(id: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM providers WHERE id=?').get(id) as ProviderRow | undefined;
  }
  findProviderByXrpl(addr: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM providers WHERE xrpl_address=? ORDER BY created_at DESC').get(addr) as ProviderRow | undefined;
  }
  listProviders(): ProviderRow[] {
    return this.db.prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[];
  }

  // credentials
  upsertCredential(row: CredentialRow): void {
    this.upsert('credentials', row);
  }
  updateCredential(id: string, patch: Partial<CredentialRow>): void {
    this.update('credentials', id, patch);
  }
  latestCredential(providerId: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE provider_id=? ORDER BY updated_at DESC').get(providerId) as CredentialRow | undefined;
  }

  // auctions / bids
  insertAuction(row: AuctionRow): void {
    this.upsert('auctions', row);
  }
  updateAuction(id: string, patch: Partial<AuctionRow>): void {
    this.update('auctions', id, patch);
  }
  getAuction(id: string): AuctionRow | undefined {
    return this.db.prepare('SELECT * FROM auctions WHERE id=?').get(id) as AuctionRow | undefined;
  }
  listAuctions(limit = 50): AuctionRow[] {
    return this.db.prepare('SELECT * FROM auctions ORDER BY opened_at DESC LIMIT ?').all(limit) as AuctionRow[];
  }
  lastClearing(jobType: string): string | undefined {
    const r = this.db
      .prepare("SELECT clearing_unit_price FROM auctions WHERE job_type=? AND status='cleared' ORDER BY closed_at DESC LIMIT 1")
      .get(jobType) as { clearing_unit_price: string } | undefined;
    return r?.clearing_unit_price ?? undefined;
  }
  insertBid(row: BidRow): void {
    this.upsert('bids', row);
  }
  listBids(auctionId: string): BidRow[] {
    return this.db.prepare('SELECT * FROM bids WHERE auction_id=? ORDER BY received_at').all(auctionId) as BidRow[];
  }
  listBidsForAuctions(ids: string[]): BidRow[] {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT * FROM bids WHERE auction_id IN (${ids.map(() => '?').join(',')}) ORDER BY received_at`).all(...ids) as BidRow[];
  }

  // jobs
  insertJob(row: JobRow): void {
    this.upsert('jobs', row);
  }
  updateJob(id: string, patch: Partial<JobRow>): void {
    this.update('jobs', id, { ...patch, updated_at: Date.now() });
  }
  deleteJob(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  }
  getJob(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
  }
  listJobs(limit = 50): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE status != 'quoted' ORDER BY created_at DESC LIMIT ?").all(limit) as JobRow[];
  }
  countJobsDone(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='done'").get() as { n: number }).n;
  }

  // payments
  insertPayment(row: PaymentRow): void {
    this.upsert('payments', row);
  }
  updatePayment(id: string, patch: Partial<PaymentRow>): void {
    this.update('payments', id, patch);
  }
  listPayments(limit = 50): PaymentRow[] {
    return this.db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?').all(limit) as PaymentRow[];
  }
  sumSettled(currency: string): bigint {
    const rows = this.db.prepare("SELECT amount_atomic FROM payments WHERE status='settled' AND currency=?").all(currency) as { amount_atomic: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount_atomic), 0n);
  }

  // streams
  insertStream(row: StreamRow): void {
    this.upsert('streams', row);
  }
  updateStream(id: string, patch: Partial<StreamRow>): void {
    this.update('streams', id, { ...patch, updated_at: Date.now() });
  }
  getStream(id: string): StreamRow | undefined {
    return this.db.prepare('SELECT * FROM streams WHERE id=?').get(id) as StreamRow | undefined;
  }

  // agent logs
  insertLog(row: Omit<AgentLogRow, 'id'>): number {
    const r = this.db
      .prepare('INSERT INTO agent_logs (agent_id, persona, kind, text, meta_json, created_at) VALUES (@agent_id, @persona, @kind, @text, @meta_json, @created_at)')
      .run(row);
    return Number(r.lastInsertRowid);
  }
  listLogs(limit = 100): AgentLogRow[] {
    return (this.db.prepare('SELECT * FROM agent_logs ORDER BY id DESC LIMIT ?').all(limit) as AgentLogRow[]).reverse();
  }

  // price ticks
  insertTick(row: Omit<TickRow, 'id'>): void {
    this.db.prepare('INSERT INTO price_ticks (job_type, currency, unit_price, demand, supply, ts) VALUES (@job_type, @currency, @unit_price, @demand, @supply, @ts)').run(row);
  }
  listTicks(sinceTs: number): TickRow[] {
    return this.db.prepare('SELECT * FROM price_ticks WHERE ts >= ? ORDER BY ts').all(sinceTs) as TickRow[];
  }
}
