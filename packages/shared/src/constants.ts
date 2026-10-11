export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_CAIP2 = 'eip155:84532' as const;
export const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';
export const XRPL_TESTNET_EXPLORER = 'https://testnet.xrpl.org';

export const DEFAULT_AUSD_ADDRESS = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' as const;
export const DEFAULT_AUSD_FAUCET = '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C' as const;

export const CREDENTIAL_TYPES = {
  A: 'IDLE_DC_TIER_A',
  B: 'IDLE_DC_TIER_B',
} as const;
export type Tier = keyof typeof CREDENTIAL_TYPES;

export const JOB_TYPES = ['embed', 'generate', 'stream'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const basescanTx = (hash: string) => `${BASE_SEPOLIA_EXPLORER}/tx/${hash}`;
export const basescanAddress = (addr: string) => `${BASE_SEPOLIA_EXPLORER}/address/${addr}`;
export const xrplTx = (hash: string) => `${XRPL_TESTNET_EXPLORER}/transactions/${hash}`;
export const xrplAccount = (addr: string) => `${XRPL_TESTNET_EXPLORER}/accounts/${addr}`;
