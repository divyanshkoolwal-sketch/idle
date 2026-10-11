export const XRPL = 'https://testnet.xrpl.org';
export const BASESCAN = 'https://sepolia.basescan.org';
export const xrplTx = (h: string) => `${XRPL}/transactions/${h}`;
export const xrplAccount = (a: string) => `${XRPL}/accounts/${a}`;
export const basescanTx = (h: string) => `${BASESCAN}/tx/${h}`;
export const basescanAddress = (a: string) => `${BASESCAN}/address/${a}`;
