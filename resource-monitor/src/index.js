import express from 'express';
import monitorRoutes from './routes/monitor.js';
import { start as startPoller } from './poller.js';

const PORT = parseInt(process.env.PORT ?? '3004', 10);

const app = express();
app.use(express.json());
app.use(monitorRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`resource-monitor listening on :${PORT}`);
  startPoller();
});

export default app;
