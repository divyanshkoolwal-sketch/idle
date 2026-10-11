#!/usr/bin/env tsx
/**
 * Idle MCP server: any MCP-capable agent (Claude Code, Cursor, …) can buy compute on the Idle spot market
 * with one tool call. Pays real testnet money (AUSD over x402, XRP over payment channels) under the budget
 * caps in .env (AGENT_BUDGET_AUSD / AGENT_BUDGET_XRP). stdout is the MCP channel; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Wallet } from 'xrpl';
import { formatUnits } from '@idle/shared';
import { cfg, MarketClient, AgentLogger, PERSONAS, streamGeneration, XrpBudget } from '@idle/agent';

const persona = PERSONAS.analyst;
const log = new AgentLogger('agent-mcp', 'mcp', cfg.exchangeUrl, true);
const market = new MarketClient(cfg.exchangeUrl, cfg.evmKey(), cfg.budgetAusd, persona, log);
const xrp = new XrpBudget(cfg.budgetDrops);
let wallet: Wallet | undefined;
let issuer: string | undefined;
async function ctx() {
  if (!issuer) issuer = (await market.snapshot()).issuer;
  if (!wallet) wallet = Wallet.fromSeed(cfg.xrplSeed());
  return { exchangeUrl: cfg.exchangeUrl, wallet, issuer, persona, log, budget: xrp };
}
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

const server = new McpServer({ name: 'idle', version: '0.1.0' });

server.registerTool(
  'idle_market',
  { title: 'Idle market snapshot', description: 'Data centers online/verified, free capacity, clearing prices per job type (atomic units) and current asks.' },
  async () => {
    try {
      const s = await market.snapshot();
      const online = s.providers.filter((p) => p.online);
      return text({
        exchange: cfg.exchangeUrl,
        providersOnline: online.length,
        providersVerified: online.filter((p) => p.status === 'verified').length,
        slots: { total: s.stats.slotsTotal, busy: s.stats.slotsBusy },
        clearing: s.stats.clearing,
        providers: online.map((p) => ({ name: p.name, tier: p.tier, status: p.status, busy: `${p.busySlots}/${p.slots}`, asks: p.asks, strikes: p.strikes, hardware: p.hardware.label })),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'idle_embed',
  {
    title: 'Buy embeddings',
    description: 'Embed up to 64 texts on the Idle spot market, paid in AUSD over x402 to the auction winner after verification. Returns vectors and the Basescan receipt.',
    inputSchema: { texts: z.array(z.string()).min(1).max(64), maxUnitPrice: z.number().int().positive().optional().describe('max micro-AUSD per text'), deadlineMs: z.number().int().positive().optional() },
  },
  async ({ texts, maxUnitPrice, deadlineMs }) => {
    try {
      const p = await market.buyEmbeddings(texts, { maxUnitPrice: maxUnitPrice ? BigInt(maxUnitPrice) : undefined, deadlineMs });
      return text({ provider: p.result.providerName, dims: p.result.output.embeddings?.[0]?.length, embeddings: p.result.output.embeddings, paidAusd: formatUnits(p.amount, 6, 6), receipt: p.result.receipt, verification: p.result.verification });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'idle_generate',
  {
    title: 'Buy a generation',
    description: 'Generate text on the Idle spot market. rail "x402" pays AUSD up front per token; rail "stream" pays XRP per delivered token over an XRPL payment channel and can stop early (stopAfterTokens).',
    inputSchema: {
      prompt: z.string().min(1),
      maxTokens: z.number().int().min(16).max(512).default(256),
      rail: z.enum(['x402', 'stream']).default('x402'),
      maxUnitPrice: z.number().int().positive().optional().describe('micro-AUSD per token (x402) or drops per token (stream)'),
      stopAfterTokens: z.number().int().positive().optional(),
    },
  },
  async ({ prompt, maxTokens, rail, maxUnitPrice, stopAfterTokens }) => {
    try {
      if (rail === 'stream') {
        const c = await ctx();
        const out = await streamGeneration(c, prompt, { maxTokens, maxDropsPerToken: maxUnitPrice ? BigInt(maxUnitPrice) : undefined, stopAfterTokens, model: cfg.genModel });
        return text({ rail, provider: out.providerName, text: out.text, tokens: out.tokens, dropsPerToken: out.dropsPerToken.toString(), xrpPaid: formatUnits(out.dropsPaid, 6), claimTx: out.claimTx ? `https://testnet.xrpl.org/transactions/${out.claimTx}` : undefined, stoppedEarly: out.stopped });
      }
      const p = await market.buyGeneration(prompt, maxTokens, { maxUnitPrice: maxUnitPrice ? BigInt(maxUnitPrice) : undefined, model: cfg.genModel });
      return text({ rail, provider: p.result.providerName, text: p.result.output.text, tokens: p.result.output.tokens, paidAusd: formatUnits(p.amount, 6, 6), receipt: p.result.receipt });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool('idle_budget', { title: 'Budget', description: 'Spent and remaining budget in AUSD and XRP for this agent wallet.' }, async () => {
  const b = market.budget();
  return text({ wallet: market.address, ausd: { spent: formatUnits(b.spent, 6, 4), remaining: formatUnits(b.remaining, 6, 4), budget: formatUnits(b.budget, 6) }, xrp: { authorized: formatUnits(xrp.authorized, 6), remaining: formatUnits(xrp.remaining, 6) }, receipts: market.receipts.slice(-10) });
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[idle-mcp] ready; exchange ${cfg.exchangeUrl}; wallet ${market.address}`);
