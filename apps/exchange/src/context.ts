import type { Config } from './config';
import type { Repo } from './db/repo';
import type { EventBus } from './events';
import type { Reference } from './reference';
import type { ProviderRegistry } from './providers';
import type { CredentialService } from './credentials';
import type { AuctionEngine } from './auction';
import type { Market } from './market';
import type { Verifier } from './verify';
import type { StreamHub } from './streams';

/** Wired once at boot (index.ts); modules read siblings lazily at call time. */
export interface Ctx {
  config: Config;
  repo: Repo;
  events: EventBus;
  reference: Reference;
  registry: ProviderRegistry;
  credentials: CredentialService;
  auctions: AuctionEngine;
  market: Market;
  verifier: Verifier;
  streams: StreamHub;
}
