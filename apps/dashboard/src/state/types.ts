import type { ProviderView, AuctionView, JobView, PriceTick, MarketStats, AgentLog } from '@shared/protocol';

export type FeedTone = 'live' | 'ink' | 'bad';
export interface FeedItem {
  id: string;
  ts: number;
  tone: FeedTone;
  kind: string;
  title: string;
  detail?: string;
  href?: string;
  linkLabel?: string;
}

export interface StreamState {
  streamId: string;
  providerId: string;
  channelId: string;
  buyer: string;
  dropsPerToken: string;
  tokens: number;
  claimedDrops: string;
  claims: number;
  maxTokens?: number;
  settledTx?: string;
  openedAt: number;
  lastTs: number;
}

export type SourceMode = 'live' | 'replay';
export type ConnState = 'connecting' | 'open' | 'closed';

export interface MarketState {
  providers: Record<string, ProviderView>;
  auctions: AuctionView[]; // newest first
  jobs: Record<string, JobView>;
  feed: FeedItem[]; // newest first
  prices: PriceTick[]; // ascending ts
  stats: MarketStats;
  logs: AgentLog[]; // ascending
  streams: Record<string, StreamState>;
  issuer: string;
  now: number; // replay-safe clock: last event ts
  wins: Record<string, number>; // providerId -> ts of last win (glow)
  revokedAt: Record<string, number>; // providerId -> ts of revocation seen in this session
  eventCount: number;
  openAuctions: number;
}

export const EMPTY_STATS: MarketStats = {
  jobsCleared: 0,
  ausdSettled: '0',
  dropsStreamed: '0',
  providersOnline: 0,
  providersVerified: 0,
  slotsTotal: 0,
  slotsBusy: 0,
  clearing: {},
};

export const initialState: MarketState = {
  providers: {},
  auctions: [],
  jobs: {},
  feed: [],
  prices: [],
  stats: EMPTY_STATS,
  logs: [],
  streams: {},
  issuer: '',
  now: 0,
  wins: {},
  revokedAt: {},
  eventCount: 0,
  openAuctions: 0,
};
