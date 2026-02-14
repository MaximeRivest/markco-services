const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const inviteRoutes = require('./routes/invites');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

app.use(authRoutes);
app.use(inviteRoutes);

// Run schema on startup, then listen
async function start() {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('Database schema applied');
  } catch (err) {
    console.error('Schema error:', err.message);
    // Continue anyway — tables may already exist
  }

  app.listen(PORT, () => {
    console.log(`auth-service listening on :${PORT}`);
  });
}

// Allow importing app for tests without starting
if (require.main === module) {
  start();
} else {
  module.exports = { app, start };
}
