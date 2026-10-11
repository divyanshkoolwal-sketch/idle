import { getAddress, hashDomain, parseAbi, type Address, type Hex } from 'viem';
import { DEFAULT_AUSD_ADDRESS, DEFAULT_AUSD_FAUCET, BASE_SEPOLIA_CHAIN_ID } from '@idle/shared';
import { getPublicClient, type WalletClientWithPublic } from './chain';

export const AUSD_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function version() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);

export const FAUCET_ABI = parseAbi(['function requestFunds(address recipient)']);

export const ausdAddress = (): Address => getAddress(process.env.AUSD_ADDRESS ?? DEFAULT_AUSD_ADDRESS);
export const ausdFaucetAddress = (): Address => getAddress(process.env.AUSD_FAUCET ?? DEFAULT_AUSD_FAUCET);

export interface AusdDomain {
  name: string;
  version: string;
  decimals: number;
  chainId: number;
  verifyingContract: Address;
  onChainSeparator: Hex;
  computedSeparator: Hex;
  verified: boolean;
  source: 'eip712Domain' | 'name+version' | 'name+default-version';
}

/**
 * Reads the EIP-712 domain the way the plan prescribes: eip712Domain() (EIP-5267) first,
 * then name()+version(), then version "1". Proves it by recomputing DOMAIN_SEPARATOR().
 */
export async function loadAusdDomain(token: Address = ausdAddress()): Promise<AusdDomain> {
  const client = getPublicClient();
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: token, abi: AUSD_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

  let name: string;
  let version: string;
  let source: AusdDomain['source'];
  try {
    const d = await read<readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]]>('eip712Domain');
    name = d[1];
    version = d[2];
    source = 'eip712Domain';
  } catch {
    name = await read<string>('name');
    try {
      version = await read<string>('version');
      source = 'name+version';
    } catch {
      version = '1';
      source = 'name+default-version';
    }
  }
  const [decimals, onChainSeparator] = await Promise.all([read<number>('decimals'), read<Hex>('DOMAIN_SEPARATOR')]);
  const computedSeparator = hashDomain({
    domain: { name, version, chainId: BigInt(BASE_SEPOLIA_CHAIN_ID), verifyingContract: token },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
  return {
    name,
    version,
    decimals: Number(decimals),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    verifyingContract: token,
    onChainSeparator,
    computedSeparator,
    verified: onChainSeparator.toLowerCase() === computedSeparator.toLowerCase(),
    source,
  };
}

/** The domain pinned in .env by `pnpm setup:ausd-domain`. */
export function ausdDomainFromEnv(): { name: string; version: string; decimals: number } {
  const name = process.env.AUSD_EIP712_NAME;
  const version = process.env.AUSD_EIP712_VERSION;
  const decimals = process.env.AUSD_DECIMALS;
  if (!name || !version || !decimals) {
    throw new Error('AUSD_EIP712_NAME / AUSD_EIP712_VERSION / AUSD_DECIMALS missing — run `pnpm setup:ausd-domain`');
  }
  return { name, version, decimals: Number(decimals) };
}

export async function ausdBalance(address: Address, token: Address = ausdAddress()): Promise<bigint> {
  return getPublicClient().readContract({ address: token, abi: AUSD_ABI, functionName: 'balanceOf', args: [address] });
}

export async function ethBalance(address: Address): Promise<bigint> {
  return getPublicClient().getBalance({ address });
}

/** Mints 10,000 AUSD to `recipient`. The caller pays a dust amount of Base Sepolia ETH for gas. */
export async function requestAusdFromFaucet(wallet: WalletClientWithPublic, recipient: Address): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: ausdFaucetAddress(),
    abi: FAUCET_ABI,
    functionName: 'requestFunds',
    args: [recipient],
  });
  await wallet.waitForTransactionReceipt({ hash });
  return hash;
}

const SELECTORS = {
  transferWithAuthorization_vrs: 'e3ee160e',
  transferWithAuthorization_bytes: 'cf092995',
  receiveWithAuthorization_vrs: 'ef55bec6',
  receiveWithAuthorization_bytes: '88b7ab63',
} as const;

/** Which ERC-3009 overloads the (proxied) token actually exposes, from its implementation bytecode. */
export async function detectErc3009Overloads(token: Address = ausdAddress()) {
  const client = getPublicClient();
  const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const raw = await client.getStorageAt({ address: token, slot: implSlot });
  const impl = raw && raw !== '0x' + '0'.repeat(64) ? getAddress(('0x' + raw.slice(-40)) as Hex) : undefined;
  const code = ((await client.getCode({ address: impl ?? token })) ?? '0x').toLowerCase();
  const has = (sel: string) => code.includes('63' + sel);
  return {
    implementation: impl,
    transferWithAuthorization: { bytes: has(SELECTORS.transferWithAuthorization_bytes), vrs: has(SELECTORS.transferWithAuthorization_vrs) },
    receiveWithAuthorization: { bytes: has(SELECTORS.receiveWithAuthorization_bytes), vrs: has(SELECTORS.receiveWithAuthorization_vrs) },
  };
}
