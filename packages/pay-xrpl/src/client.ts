import { Client } from 'xrpl';

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

/** Shared XRPL testnet client (lazy, reconnects if dropped). */
export async function getXrplClient(): Promise<Client> {
  if (client?.isConnected()) return client;
  if (!connecting) {
    connecting = (async () => {
      const url = process.env.XRPL_WSS ?? 'wss://s.altnet.rippletest.net:51233';
      const c = new Client(url, { timeout: 20_000 });
      await c.connect();
      client = c;
      connecting = null;
      return c;
    })().catch((e) => {
      connecting = null;
      throw e;
    });
  }
  return connecting;
}

export async function disconnectXrpl(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    await c.disconnect();
  }
}
