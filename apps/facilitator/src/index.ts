import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, env, envInt, formatUnits } from '@idle/shared';
import { createFacilitator } from './app';

loadEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

const port = envInt('FACILITATOR_PORT', 4022);
const host = process.env.FACILITATOR_HOST || '127.0.0.1'; // loopback only: the exchange is the only caller
const { app, address, wallet } = createFacilitator(env('FACILITATOR_PRIVATE_KEY') as `0x${string}`);

app.listen(port, host, async () => {
  console.log(`[facilitator] listening on ${host}:${port}  relayer=${address}`);
  try {
    const bal = await wallet.getBalance({ address });
    console.log(`[facilitator] relayer ETH balance: ${formatUnits(bal, 18, 6)}`);
    if (bal < 10n ** 14n) console.warn('[facilitator] WARNING: relayer has < 0.0001 ETH; settlements will fail. Fund it from a Base Sepolia faucet.');
  } catch (e) {
    console.warn('[facilitator] could not read relayer balance:', (e as Error).message);
  }
});
