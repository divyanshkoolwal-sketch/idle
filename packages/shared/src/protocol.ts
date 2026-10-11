/**
 * Wire contract shared by exchange, providers, agents and the dashboard.
 * Money on the wire is always a decimal string of atomic units (AUSD 10^-6 or XRP drops).
 */
import { z } from 'zod';

export const Atomic = z.string().regex(/^\d+$/, 'atomic amount must be a non-negative integer string');
export const JobType = z.enum(['embed', 'generate', 'stream']);
export const Currency = z.enum(['AUSD', 'XRP']);
export const Tier = z.enum(['A', 'B']);
export const ProviderStatus = z.enum(['pending', 'verified', 'suspended', 'offline']);
export const Rail = z.enum(['x402', 'xrpl']);
export const JobStatus = z.enum(['quoted', 'paid_pending', 'running', 'verifying', 'done', 'failed']);
export const PaymentStatus = z.enum(['verified', 'settled', 'not_settled']);

export type JobType = z.infer<typeof JobType>;
export type Currency = z.infer<typeof Currency>;
export type Tier = z.infer<typeof Tier>;
export type ProviderStatus = z.infer<typeof ProviderStatus>;

// ---------------------------------------------------------------------------
// Provider ⇄ Exchange websocket (`WS /v1/providers/ws`)
// ---------------------------------------------------------------------------

export const Hardware = z.object({
  cpu: z.string(),
  chip: z.string().optional(), // e.g. "Apple M3 Pro"
  ramGb: z.number(),
  label: z.string(), // "Apple M3 Pro · 18 GB"
});

export const Benchmark = z.object({ embedTps: z.number(), genTps: z.number(), embedMs: z.number(), genMs: z.number() });

export const Asks = z.object({ embed: Atomic, generate: Atomic, stream: Atomic }); // current per-unit asks

/** provider → exchange */
export const ProviderMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    providerId: z.string().optional(), // reconnecting providers send their id back
    name: z.string(),
    region: z.string(),
    hardware: Hardware,
    evmAddress: z.string(),
    xrplAddress: z.string(),
    xrplPublicKey: z.string(),
    models: z.array(z.string()),
    slots: z.number().int().positive(),
    benchmark: Benchmark,
    floors: z.object({ embed: Atomic, generate: Atomic, streamDrops: Atomic }),
    cheat: z.boolean().default(false),
    version: z.string().default('0.1.0'),
  }),
  z.object({ type: z.literal('challenge.result'), challengeId: z.string(), embeddings: z.array(z.array(z.number())), ms: z.number() }),
  z.object({ type: z.literal('credential.accepted'), txHash: z.string() }),
  z.object({
    type: z.literal('bid'),
    auctionId: z.string(),
    unitPrice: Atomic,
    etaMs: z.number(),
    shade: z.number(),
    surge: z.number(),
  }),
  z.object({ type: z.literal('pass'), auctionId: z.string(), reason: z.string() }), // explicit no-bid (speeds up auction close)
  z.object({
    type: z.literal('result'),
    jobId: z.string(),
    ok: z.boolean(),
    output: z.object({ embeddings: z.array(z.array(z.number())).optional(), text: z.string().optional(), tokens: z.number().optional() }).optional(),
    ms: z.number().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('stream.token'), streamId: z.string(), token: z.string(), index: z.number() }),
  z.object({ type: z.literal('stream.paused'), streamId: z.string(), unpaidTokens: z.number() }),
  z.object({ type: z.literal('stream.end'), streamId: z.string(), tokensDelivered: z.number(), reason: z.enum(['done', 'stopped', 'error', 'unpaid']), error: z.string().optional() }),
  z.object({ type: z.literal('stream.claimed'), streamId: z.string(), txHash: z.string(), drops: Atomic, tokens: z.number() }),
  z.object({
    type: z.literal('heartbeat'),
    busySlots: z.number(),
    queueDepth: z.number(),
    shade: z.number(),
    surge: z.number(),
    asks: Asks,
    draining: z.boolean().default(false),
    cheat: z.boolean().default(false),
  }),
]);
export type ProviderMessage = z.infer<typeof ProviderMessage>;

export const JobInput = z.object({
  texts: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  seed: z.number().optional(),
});

/** exchange → provider */
export const ExchangeMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), providerId: z.string(), issuerAddress: z.string(), status: ProviderStatus, tier: Tier.optional() }),
  z.object({ type: z.literal('challenge'), challengeId: z.string(), model: z.string(), texts: z.array(z.string()), deadlineMs: z.number() }),
  z.object({ type: z.literal('challenge.failed'), challengeId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('credential.offered'), credentialType: z.string(), issuer: z.string(), txHash: z.string(), tier: Tier }),
  z.object({ type: z.literal('verified'), tier: Tier }),
  z.object({
    type: z.literal('rfq'),
    auctionId: z.string(),
    jobType: JobType,
    model: z.string(),
    units: z.number().int().positive(),
    currency: Currency,
    maxUnitPrice: Atomic,
    deadlineMs: z.number(),
    closeAt: z.number(), // epoch ms
  }),
  z.object({ type: z.literal('award'), auctionId: z.string(), clearingUnitPrice: Atomic, quoteExpiresAt: z.number() }),
  z.object({ type: z.literal('lose'), auctionId: z.string(), clearingUnitPrice: Atomic.optional() }),
  z.object({ type: z.literal('release'), auctionId: z.string() }), // reservation expired / payment failed
  z.object({
    type: z.literal('job'),
    jobId: z.string(),
    auctionId: z.string(),
    jobType: JobType,
    model: z.string(),
    input: JobInput,
    unitPrice: Atomic,
    currency: Currency,
  }),
  z.object({
    type: z.literal('stream.start'),
    streamId: z.string(),
    jobId: z.string(),
    model: z.string(),
    prompt: z.string(),
    maxTokens: z.number(),
    channelId: z.string(),
    buyerAddress: z.string(),
    buyerPublicKey: z.string(),
    dropsPerToken: Atomic,
    priorClaimedDrops: Atomic, // highest claim already authorised on this channel before this stream
  }),
  z.object({ type: z.literal('stream.claim'), streamId: z.string(), amountDrops: Atomic, signature: z.string() }),
  z.object({ type: z.literal('stream.stop'), streamId: z.string() }),
  z.object({ type: z.literal('drain'), on: z.boolean() }),
  z.object({ type: z.literal('cheat'), on: z.boolean() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ExchangeMessage = z.infer<typeof ExchangeMessage>;

// ---------------------------------------------------------------------------
// Public read models (REST + dashboard)
// ---------------------------------------------------------------------------

export const ProviderView = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  hardware: Hardware,
  evmAddress: z.string(),
  xrplAddress: z.string(),
  models: z.array(z.string()),
  slots: z.number(),
  busySlots: z.number(),
  queueDepth: z.number(),
  benchmark: Benchmark,
  tier: Tier.optional(),
  status: ProviderStatus,
  strikes: z.number(),
  shade: z.number(),
  surge: z.number(),
  asks: Asks,
  floors: z.object({ embed: Atomic, generate: Atomic, streamDrops: Atomic }),
  credential: z.object({ type: z.string(), issueTx: z.string().optional(), acceptTx: z.string().optional(), deleteTx: z.string().optional(), status: z.string() }).optional(),
  earnings: z.object({ ausd: Atomic, drops: Atomic }),
  jobsDone: z.number(),
  cheat: z.boolean(),
  draining: z.boolean(),
  online: z.boolean(),
  lastSeen: z.number(),
});
export type ProviderView = z.infer<typeof ProviderView>;

export const BidView = z.object({
  providerId: z.string(),
  providerName: z.string(),
  unitPrice: Atomic,
  etaMs: z.number(),
  shade: z.number().optional(),
  surge: z.number().optional(),
  valid: z.boolean(),
  reason: z.string().optional(),
  receivedAt: z.number(),
});
export type BidView = z.infer<typeof BidView>;

export const AuctionView = z.object({
  id: z.string(),
  jobId: z.string().optional(),
  jobType: JobType,
  model: z.string(),
  units: z.number(),
  currency: Currency,
  maxUnitPrice: Atomic,
  deadlineMs: z.number(),
  persona: z.string().optional(),
  agentId: z.string().optional(),
  openedAt: z.number(),
  closedAt: z.number().optional(),
  status: z.enum(['open', 'cleared', 'no_bids', 'no_acceptable_bid', 'expired']),
  winnerProviderId: z.string().optional(),
  winnerName: z.string().optional(),
  clearingUnitPrice: Atomic.optional(),
  bids: z.array(BidView),
});
export type AuctionView = z.infer<typeof AuctionView>;

export const PaymentView = z.object({
  id: z.string(),
  jobId: z.string(),
  auctionId: z.string().optional(),
  rail: Rail,
  currency: Currency,
  amount: Atomic,
  payer: z.string(),
  payee: z.string(),
  payeeName: z.string().optional(),
  txHash: z.string().optional(),
  explorerUrl: z.string().optional(),
  status: PaymentStatus,
  reason: z.string().optional(),
  createdAt: z.number(),
});
export type PaymentView = z.infer<typeof PaymentView>;

export const JobView = z.object({
  id: z.string(),
  auctionId: z.string(),
  agentId: z.string().optional(),
  persona: z.string().optional(),
  jobType: JobType,
  model: z.string(),
  units: z.number(),
  rail: Rail,
  status: JobStatus,
  providerId: z.string().optional(),
  providerName: z.string().optional(),
  unitPrice: Atomic,
  amount: Atomic,
  currency: Currency,
  latencyMs: z.number().optional(),
  verification: z.object({ sampled: z.boolean(), passed: z.boolean().optional(), cosine: z.number().optional() }).optional(),
  createdAt: z.number(),
});
export type JobView = z.infer<typeof JobView>;

export const AgentLog = z.object({
  agentId: z.string(),
  persona: z.string(),
  kind: z.enum(['thought', 'action', 'spend', 'result', 'error']),
  text: z.string(),
  ts: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type AgentLog = z.infer<typeof AgentLog>;

export const MarketStats = z.object({
  jobsCleared: z.number(),
  ausdSettled: Atomic,
  dropsStreamed: Atomic,
  providersOnline: z.number(),
  providersVerified: z.number(),
  slotsTotal: z.number(),
  slotsBusy: z.number(),
  clearing: z.object({ embed: Atomic.optional(), generate: Atomic.optional(), stream: Atomic.optional() }),
});
export type MarketStats = z.infer<typeof MarketStats>;

export const PriceTick = z.object({ jobType: JobType, currency: Currency, unitPrice: Atomic, ts: z.number(), demand: z.number().optional(), supply: z.number().optional() });
export type PriceTick = z.infer<typeof PriceTick>;

// ---------------------------------------------------------------------------
// Dashboard event stream (`WS /v1/events`). Every frame: { type, ts, ...payload }
// ---------------------------------------------------------------------------

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ type: z.literal(type), ts: z.number(), ...shape });

export const DashboardEvent = z.discriminatedUnion('type', [
  ev('snapshot', {
    providers: z.array(ProviderView),
    auctions: z.array(AuctionView),
    payments: z.array(PaymentView),
    jobs: z.array(JobView),
    stats: MarketStats,
    prices: z.array(PriceTick),
    logs: z.array(AgentLog),
    issuer: z.string(),
  }),
  ev('provider.online', { provider: ProviderView }),
  ev('provider.offline', { providerId: z.string() }),
  ev('provider.util', { providerId: z.string(), busySlots: z.number(), slots: z.number(), queueDepth: z.number(), shade: z.number(), surge: z.number(), asks: Asks, draining: z.boolean(), cheat: z.boolean() }),
  ev('provider.verified', { providerId: z.string(), tier: Tier, credential: z.object({ type: z.string(), issueTx: z.string(), acceptTx: z.string() }) }),
  ev('provider.suspended', { providerId: z.string(), strikes: z.number(), deleteTx: z.string().optional() }),
  ev('provider.strike', { providerId: z.string(), strikes: z.number(), jobId: z.string() }),
  ev('auction.opened', { auction: AuctionView }),
  ev('auction.bid', { auctionId: z.string(), bid: BidView }),
  ev('auction.cleared', { auction: AuctionView }),
  ev('auction.failed', { auction: AuctionView, reason: z.string() }),
  ev('job.dispatched', { job: JobView }),
  ev('job.completed', { job: JobView }),
  ev('job.failed', { job: JobView, error: z.string() }),
  ev('verify.passed', { jobId: z.string(), providerId: z.string(), cosine: z.number() }),
  ev('verify.failed', { jobId: z.string(), providerId: z.string(), cosine: z.number(), strikes: z.number() }),
  ev('payment.verified', { payment: PaymentView }),
  ev('payment.settled', { payment: PaymentView }),
  ev('payment.not_settled', { payment: PaymentView }),
  ev('credential.issued', { providerId: z.string(), providerName: z.string(), txHash: z.string(), credentialType: z.string(), tier: Tier }),
  ev('credential.accepted', { providerId: z.string(), providerName: z.string(), txHash: z.string() }),
  ev('credential.revoked', { providerId: z.string(), providerName: z.string(), txHash: z.string(), strikes: z.number() }),
  ev('paychan.opened', { streamId: z.string(), channelId: z.string(), buyer: z.string(), providerId: z.string(), dropsPerToken: Atomic }),
  ev('paychan.claim', { streamId: z.string(), providerId: z.string(), drops: Atomic, tokens: z.number() }),
  ev('paychan.claimed', { streamId: z.string(), providerId: z.string(), txHash: z.string(), drops: Atomic, tokens: z.number() }),
  ev('stream.token', { streamId: z.string(), providerId: z.string(), index: z.number() }),
  ev('price.tick', { tick: PriceTick }),
  ev('stats', { stats: MarketStats }),
  ev('agent.log', { log: AgentLog }),
]);
export type DashboardEvent = z.infer<typeof DashboardEvent>;
export type DashboardEventType = DashboardEvent['type'];

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** POST /v1/jobs (x402 rail). Header `Idempotency-Key: <uuid>` required. */
export const CreateJobRequest = z.object({
  jobType: z.enum(['embed', 'generate']),
  model: z.string().optional(),
  input: JobInput,
  maxUnitPrice: Atomic,
  deadlineMs: z.number().int().positive().default(10_000),
  minTier: Tier.optional(),
  persona: z.string().optional(),
  agentId: z.string().optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const Quote = z.object({
  quoteId: z.string(),
  auctionId: z.string(),
  jobId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerXrplAddress: z.string(),
  payTo: z.string(), // EVM address for x402, XRPL address for streams
  unitPrice: Atomic,
  units: z.number(),
  amount: Atomic,
  currency: Currency,
  expiresAt: z.number(),
  bids: z.array(BidView),
});
export type Quote = z.infer<typeof Quote>;

/** 402 body (the PAYMENT-REQUIRED header carries the x402 requirements) */
export const PaymentRequiredBody = z.object({ error: z.literal('PAYMENT_REQUIRED'), quote: Quote });

export const JobResult = z.object({
  jobId: z.string(),
  auctionId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  output: z.object({ embeddings: z.array(z.array(z.number())).optional(), text: z.string().optional(), tokens: z.number().optional() }),
  latencyMs: z.number(),
  verification: z.object({ sampled: z.boolean(), passed: z.boolean().optional(), cosine: z.number().optional() }),
  receipt: z
    .object({ txHash: z.string(), explorerUrl: z.string(), amount: Atomic, currency: Currency, payee: z.string(), unitPrice: Atomic })
    .optional(), // absent when PAYMENTS=off
});
export type JobResult = z.infer<typeof JobResult>;

export type PaymentRequiredBody = z.infer<typeof PaymentRequiredBody>;
export const NoCapacity = z.object({ error: z.literal('NO_CAPACITY'), retryAfterMs: z.number() });
export const NoAcceptableBid = z.object({ error: z.literal('NO_ACCEPTABLE_BID'), bestBid: BidView.optional(), suggestedMaxUnitPrice: Atomic.optional(), auctionId: z.string() });
export const ProviderFailed = z.object({ error: z.literal('PROVIDER_FAILED_VERIFICATION'), charged: z.literal(false), jobId: z.string(), providerId: z.string(), cosine: z.number().optional() });
export type NoCapacity = z.infer<typeof NoCapacity>;
export type NoAcceptableBid = z.infer<typeof NoAcceptableBid>;
export type ProviderFailed = z.infer<typeof ProviderFailed>;

/** POST /v1/streams */
export const CreateStreamRequest = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  maxTokens: z.number().int().positive().max(2048),
  maxDropsPerToken: Atomic,
  deadlineMs: z.number().int().positive().default(15_000),
  persona: z.string().optional(),
  agentId: z.string().optional(),
});
export type CreateStreamRequest = z.infer<typeof CreateStreamRequest>;
export const StreamQuote = z.object({
  quoteId: z.string(),
  streamId: z.string(),
  auctionId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerXrplAddress: z.string(),
  dropsPerToken: Atomic,
  maxTokens: z.number(),
  expiresAt: z.number(),
  bids: z.array(BidView),
});
export type StreamQuote = z.infer<typeof StreamQuote>;

/** WS /v1/streams/:quoteId — agent → exchange */
export const StreamClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), channelId: z.string(), publicKey: z.string(), buyerAddress: z.string(), priorClaimedDrops: Atomic.default('0') }),
  z.object({ type: z.literal('claim'), amountDrops: Atomic, signature: z.string() }),
  z.object({ type: z.literal('stop') }),
]);
/** exchange → agent */
export const StreamServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), streamId: z.string(), dropsPerToken: Atomic }),
  z.object({ type: z.literal('token'), token: z.string(), index: z.number() }),
  z.object({ type: z.literal('paused'), unpaidTokens: z.number() }),
  z.object({ type: z.literal('end'), tokensDelivered: z.number(), reason: z.enum(['done', 'stopped', 'error', 'unpaid']), error: z.string().optional() }),
  z.object({ type: z.literal('claimed'), txHash: z.string(), drops: Atomic, tokens: z.number(), explorerUrl: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type StreamClientMessage = z.infer<typeof StreamClientMessage>;
export type StreamServerMessage = z.infer<typeof StreamServerMessage>;

/** GET /v1/market */
export const MarketSnapshot = z.object({
  providers: z.array(ProviderView),
  stats: MarketStats,
  recentClearing: z.array(PriceTick),
  /** bid-depth curve per job type: sorted asks of online providers */
  depth: z.object({ embed: z.array(Atomic), generate: z.array(Atomic), stream: z.array(Atomic) }),
  issuer: z.string(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

/** POST /v1/agents/:id/log */
export const AgentLogRequest = AgentLog.omit({ agentId: true, ts: true }).extend({ ts: z.number().optional() });

/** POST /v1/admin/{burst|cheat|drain} — bearer ADMIN_TOKEN */
export const AdminBurst = z.object({ jobs: z.number().int().positive().default(20), jobType: z.enum(['embed', 'generate']).default('embed') });
export const AdminProviderToggle = z.object({ providerId: z.string(), on: z.boolean() });
