import { authorizeChannel, encodeForSigningClaim, isCreatedNode, verifyKeypairSignature } from 'xrpl';

import type { PaymentChannelClaim, PaymentChannelCreate, Wallet } from 'xrpl';
import { getXrplClient } from './client';
import { submitTx } from './queue';

export interface ChannelInfo {
  channelId: string;
  account: string;
  destination: string;
  amountDrops: bigint; // total deposited
  balanceDrops: bigint; // already claimed on-ledger
  publicKey?: string;
  settleDelay: number;
  expiration?: number;
}

export async function openChannel(
  buyer: Wallet,
  destination: string,
  amountDrops: bigint,
  settleDelaySec = 60,
): Promise<{ channelId: string; txHash: string }> {
  const tx: PaymentChannelCreate = {
    TransactionType: 'PaymentChannelCreate',
    Account: buyer.address,
    Destination: destination,
    Amount: amountDrops.toString(),
    SettleDelay: settleDelaySec,
    PublicKey: buyer.publicKey,
  };
  const res = await submitTx(buyer, tx);
  const meta = res.result.meta;
  let channelId: string | undefined;
  if (meta && typeof meta === 'object' && 'AffectedNodes' in meta) {
    for (const n of meta.AffectedNodes) {
      if (isCreatedNode(n) && n.CreatedNode.LedgerEntryType === 'PayChannel') {
        channelId = n.CreatedNode.LedgerIndex;
        break;
      }
    }
  }
  if (!channelId) {
    // Fallback: look it up by account_channels.
    const found = await listChannels(buyer.address, destination);
    channelId = found.sort((a, b) => Number(b.amountDrops - a.amountDrops))[0]?.channelId;
  }
  if (!channelId) throw new Error('PaymentChannelCreate succeeded but channel id not found');
  return { channelId, txHash: res.result.hash };
}

export async function listChannels(account: string, destination?: string): Promise<ChannelInfo[]> {
  const client = await getXrplClient();
  const res = await client.request({
    command: 'account_channels',
    account,
    ...(destination ? { destination_account: destination } : {}),
    ledger_index: 'validated',
  });
  return res.result.channels.map((c) => ({
    channelId: c.channel_id,
    account: c.account,
    destination: c.destination_account,
    amountDrops: BigInt(c.amount),
    balanceDrops: BigInt(c.balance),
    publicKey: c.public_key_hex ?? c.public_key,
    settleDelay: c.settle_delay,
    expiration: c.expiration,
  }));
}

export async function getChannel(channelId: string): Promise<ChannelInfo | null> {
  const client = await getXrplClient();
  try {
    const res = await client.request({ command: 'ledger_entry', payment_channel: channelId, ledger_index: 'validated' });
    const node = res.result.node as unknown as Record<string, unknown>;
    return {
      channelId,
      account: String(node.Account),
      destination: String(node.Destination),
      amountDrops: BigInt(String(node.Amount)),
      balanceDrops: BigInt(String(node.Balance ?? '0')),
      publicKey: node.PublicKey ? String(node.PublicKey) : undefined,
      settleDelay: Number(node.SettleDelay),
      expiration: typeof node.Expiration === 'number' ? node.Expiration : undefined,
    };
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } }).data?.error ?? (e as Error).message ?? '';
    if (/entryNotFound/.test(code)) return null;
    throw e;
  }
}

/** Finds an open channel buyer→destination with at least `minRemainingDrops` unclaimed. */
export async function findUsableChannel(
  buyer: string,
  destination: string,
  minRemainingDrops: bigint,
): Promise<ChannelInfo | null> {
  const chans = await listChannels(buyer, destination);
  const usable = chans
    .filter((c) => c.expiration === undefined && c.amountDrops - c.balanceDrops >= minRemainingDrops)
    .sort((a, b) => Number(b.amountDrops - b.balanceDrops - (a.amountDrops - a.balanceDrops)));
  return usable[0] ?? null;
}

/** Off-ledger claim: signs the cumulative `drops` authorised on `channelId`. */
export function signClaim(buyer: Wallet, channelId: string, drops: bigint): string {
  return authorizeChannel(buyer, channelId, drops.toString());
}

export function verifyClaim(channelId: string, drops: bigint, signature: string, publicKey: string): boolean {
  const signingData = encodeForSigningClaim({ channel: channelId, amount: drops.toString() } as never);
  try {
    return verifyKeypairSignature(signingData, signature, publicKey);
  } catch {
    return false;
  }
}

/** Payee redeems the highest claim on-ledger. */
export async function submitClaim(
  payee: Wallet,
  channelId: string,
  drops: bigint,
  signature: string,
  publicKey: string,
  opts: { close?: boolean } = {},
): Promise<{ txHash: string }> {
  const tx: PaymentChannelClaim = {
    TransactionType: 'PaymentChannelClaim',
    Account: payee.address,
    Channel: channelId,
    Balance: drops.toString(),
    Amount: drops.toString(),
    Signature: signature,
    PublicKey: publicKey,
  };
  if (opts.close) tx.Flags = { tfClose: true };
  const res = await submitTx(payee, tx);
  return { txHash: res.result.hash };
}
