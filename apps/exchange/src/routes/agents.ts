import { Router } from 'express';
import { AgentLogRequest } from '@idle/shared';
import type { Ctx } from '../context';
import { logView } from '../views';

export function agentRoutes(ctx: Ctx): Router {
  const r = Router();
  r.post('/agents/:id/log', (req, res) => {
    const parsed = AgentLogRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const row = {
      agent_id: req.params.id,
      persona: parsed.data.persona,
      kind: parsed.data.kind,
      text: parsed.data.text.slice(0, 2000),
      meta_json: parsed.data.meta ? JSON.stringify(parsed.data.meta) : null,
      created_at: parsed.data.ts ?? Date.now(),
    };
    const id = ctx.repo.insertLog(row);
    ctx.events.emit({ type: 'agent.log', log: logView({ id, ...row }) });
    res.status(201).json({ ok: true, id });
  });
  r.get('/agents/logs', (req, res) => res.json(ctx.repo.listLogs(Number(req.query.limit) || 100).map(logView)));
  return r;
}
