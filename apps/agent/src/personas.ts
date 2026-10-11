export type Rail = 'x402' | 'stream';

export interface Persona {
  name: 'analyst' | 'indexer';
  /** job deadline the persona is willing to wait for a result */
  deadlineMs: number;
  /** opening max unit price (atomic AUSD per text / per token) and the ceiling it will raise to */
  embed: { open: bigint; ceiling: bigint };
  generate: { open: bigint; ceiling: bigint };
  /** drops per token for the XRPL stream rail */
  stream: { open: bigint; ceiling: bigint };
  /** when outbid: raise immediately (urgent) or wait for cheaper supply (patient) */
  patient: boolean;
  waitMs: number;
  maxRetries: number;
  finalAnswerRail: Rail;
  description: string;
}

export const PERSONAS: Record<Persona['name'], Persona> = {
  analyst: {
    name: 'analyst',
    deadlineMs: 3000,
    embed: { open: 24n, ceiling: 60n },
    generate: { open: 35n, ceiling: 90n },
    stream: { open: 55n, ceiling: 120n },
    patient: false,
    waitMs: 500,
    maxRetries: 6,
    finalAnswerRail: 'stream',
    description: 'Urgent research analyst. Pays up to get answers now; streams the final answer over an XRPL channel and stops as soon as the answer is complete.',
  },
  indexer: {
    name: 'indexer',
    deadlineMs: 60_000,
    embed: { open: 12n, ceiling: 30n },
    generate: { open: 22n, ceiling: 45n },
    stream: { open: 35n, ceiling: 70n },
    patient: true,
    waitMs: 4000,
    maxRetries: 10,
    finalAnswerRail: 'x402',
    description: 'Patient indexer filling a corpus with embeddings. Backs off when outbid and buys when prices dip.',
  },
};
