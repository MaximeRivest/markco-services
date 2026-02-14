import express from 'express';
import { initSchema } from './db.js';
import runtimesRouter from './routes/runtimes.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'compute-manager' }));

// Routes
app.use('/runtimes', runtimesRouter);

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`[compute-manager] Listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

export default app;
