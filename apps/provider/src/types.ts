import type { z } from 'zod';
import type { ExchangeMessage, ProviderMessage, Hardware as HardwareSchema, Benchmark as BenchmarkSchema } from '@idle/shared';

export type Hardware = z.infer<typeof HardwareSchema>;
export type Benchmark = z.infer<typeof BenchmarkSchema>;
export type Outbound = ProviderMessage;
export type Inbound = ExchangeMessage;
export type InboundOf<T extends Inbound['type']> = Extract<Inbound, { type: T }>;
