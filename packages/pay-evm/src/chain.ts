import { createPublicClient, createWalletClient, fallback, http, publicActions, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { nonceManager, privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

export { baseSepolia, generatePrivateKey, privateKeyToAccount };

export function rpcTransport() {
  const urls = [process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org', process.env.BASE_SEPOLIA_RPC_FALLBACK]
    .filter((u): u is string => !!u && u.trim() !== '');
  const transports = urls.map((u) => http(u, { timeout: 20_000, retryCount: 2 }));
  return transports.length > 1 ? fallback(transports) : transports[0];
}

const makePublicClient = () => createPublicClient({ chain: baseSepolia, transport: rpcTransport() });
export type BasePublicClient = ReturnType<typeof makePublicClient>;

let publicClient: BasePublicClient | null = null;
export function getPublicClient(): BasePublicClient {
  if (!publicClient) publicClient = makePublicClient();
  return publicClient;
}

/** viem account from a private key. `managedNonce` wires viem's nonceManager (use for the facilitator relayer). */
export function accountFromKey(privateKey: Hex, opts: { managedNonce?: boolean } = {}) {
  return privateKeyToAccount(privateKey, opts.managedNonce ? { nonceManager } : undefined);
}

/** Wallet client extended with public actions (readContract, waitForTransactionReceipt, ...). */
export function getWalletClient(privateKey: Hex, opts: { managedNonce?: boolean } = {}) {
  const account = accountFromKey(privateKey, opts);
  return createWalletClient({ account, chain: baseSepolia, transport: rpcTransport() }).extend(publicActions);
}
export type WalletClientWithPublic = ReturnType<typeof getWalletClient>;
