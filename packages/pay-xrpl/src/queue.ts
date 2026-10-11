import type { SubmittableTransaction, TxResponse, Wallet } from 'xrpl';
import { getXrplClient } from './client';

/**
 * Serialises transactions per account so autofill never hands out a stale Sequence,
 * and retries once on the transient results the plan calls out.
 */
const queues = new Map<string, Promise<unknown>>();

const RETRYABLE = /tefPAST_SEQ|telINSUF_FEE_P|tooBusy|noCurrent|noNetwork|LastLedgerSequence/;

export function submitTx<T extends SubmittableTransaction>(wallet: Wallet, tx: T): Promise<TxResponse<T>> {
  const prev = queues.get(wallet.address) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => submitWithRetry(wallet, tx));
  queues.set(wallet.address, run);
  return run;
}

async function submitWithRetry<T extends SubmittableTransaction>(wallet: Wallet, tx: T): Promise<TxResponse<T>> {
  const attempt = async () => {
    const client = await getXrplClient();
    const res = await client.submitAndWait(tx, { autofill: true, wallet });
    assertTxSuccess(res);
    return res;
  };
  try {
    return await attempt();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (RETRYABLE.test(msg)) {
      await new Promise((r) => setTimeout(r, 1500));
      return attempt();
    }
    throw e;
  }
}

export function txResultCode<T extends SubmittableTransaction>(res: TxResponse<T>): string {
  const meta = res.result.meta;
  if (meta && typeof meta === 'object' && 'TransactionResult' in meta) return String(meta.TransactionResult);
  return 'unknown';
}

export function assertTxSuccess<T extends SubmittableTransaction>(res: TxResponse<T>): void {
  const code = txResultCode(res);
  if (code !== 'tesSUCCESS') {
    throw new Error(`XRPL tx ${res.result.hash} failed: ${code}`);
  }
}
