import { Router } from 'express';
import { register, unregister, getAll } from '../poller.js';
import { registerWebhook, getRecentEvents, getWebhooks } from '../events.js';
import { analyzeCode } from '../code-analyzer.js';
import { clearState } from '../thresholds.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(getAll());
});

router.post('/monitor', (req, res) => {
  const { runtime_id, container_name, host, memory_limit } = req.body ?? {};
  if (!runtime_id || !container_name) {
    return res.status(400).json({ error: 'runtime_id and container_name are required' });
  }
  register({ runtime_id, container_name, host: host ?? 'localhost', memory_limit: memory_limit ?? 0 });
  res.status(201).json({ ok: true });
});

router.delete('/monitor/:runtimeId', (req, res) => {
  const { runtimeId } = req.params;
  unregister(runtimeId);
  clearState(runtimeId);
  res.json({ ok: true });
});

router.post('/events/webhook', (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  registerWebhook(url);
  res.status(201).json({ ok: true, webhooks: getWebhooks() });
});

router.get('/events/recent', (_req, res) => {
  res.json(getRecentEvents());
});

router.post('/analyze', (req, res) => {
  const { code, runtime_id, container_name, host } = req.body ?? {};
  if (!code || !runtime_id) {
    return res.status(400).json({ error: 'code and runtime_id are required' });
  }
  const hints = analyzeCode(code, { runtime_id, container_name: container_name ?? '', host: host ?? 'localhost' });
  res.json(hints);
});

export default router;
