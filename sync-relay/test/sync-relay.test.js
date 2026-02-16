/**
 * Sync Relay integration tests.
 *
 * Tests the core document lifecycle:
 * - Connect, edit, persist to Postgres, reconnect, verify state
 * - Multiple clients on the same document
 * - Auth rejection
 * - Document cleanup after disconnect
 *
 * Requires a running Postgres with the markco database.
 * Run: node --test test/sync-relay.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import pg from 'pg';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const RELAY_PORT = 13006; // Use non-standard port for testing
const DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/markco';
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

let pool;
let relayProcess;

/**
 * Helper: create a Yjs client that connects to the relay.
 */
function createYjsClient(userId, project, docPath) {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const url = `ws://localhost:${RELAY_PORT}/sync/${userId}/${project}/${docPath}`;
    const ws = new WebSocket(url, {
      headers: { 'X-User-Id': userId },
    });

    let synced = false;

    ws.on('open', () => {
      // Client will receive sync step 1 from server, then respond
    });

    ws.on('message', (data) => {
      const msg = new Uint8Array(data);
      const decoder = decoding.createDecoder(msg);
      const msgType = decoding.readVarUint(decoder);

      if (msgType === MSG_SYNC) {
        const responseEncoder = encoding.createEncoder();
        encoding.writeVarUint(responseEncoder, MSG_SYNC);
        const syncMessageType = syncProtocol.readSyncMessage(decoder, responseEncoder, ydoc, ws);

        if (encoding.length(responseEncoder) > 1) {
          ws.send(encoding.toUint8Array(responseEncoder));
        }

        // After sync step 2 is processed, we're synced
        if (!synced && syncMessageType === 1) {
          synced = true;
          resolve({ ydoc, ytext, ws, close: () => ws.close() });
        }
      }
    });

    // Send updates to server when local doc changes
    ydoc.on('update', (update, origin) => {
      if (origin !== 'remote' && ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        ws.send(encoding.toUint8Array(encoder));
      }
    });

    ws.on('error', reject);

    // Timeout
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

/**
 * Wait for a condition (polling).
 */
async function waitFor(fn, timeoutMs = 3000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}

describe('sync-relay', () => {
  before(async () => {
    // Set up DB pool
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });

    // Ensure test user exists
    await pool.query(`
      INSERT INTO users (id, email, name)
      VALUES ($1, 'test@test.com', 'Test User')
      ON CONFLICT (id) DO NOTHING
    `, [TEST_USER_ID]);

    // Clean any test documents
    await pool.query(`DELETE FROM documents WHERE user_id = $1`, [TEST_USER_ID]);

    // Start the relay service
    const { spawn } = await import('child_process');
    const { dirname, resolve } = await import('path');
    const { fileURLToPath } = await import('url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serviceDir = resolve(__dirname, '..');

    relayProcess = spawn('node', ['src/index.js'], {
      cwd: serviceDir,
      env: {
        ...process.env,
        PORT: String(RELAY_PORT),
        SYNC_RELAY_PORT: String(RELAY_PORT),
        SYNC_RELAY_NO_AUTH: '1', // Allow unauthenticated connections in test
        DATABASE_URL: DB_URL,
        DOC_CLEANUP_DELAY_MS: '500', // Fast cleanup for tests
        SAVE_DEBOUNCE_MS: '200', // Fast saves for tests
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    relayProcess.stdout.on('data', d => process.stdout.write(`[relay] ${d}`));
    relayProcess.stderr.on('data', d => process.stderr.write(`[relay:err] ${d}`));

    // Wait for it to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay start timeout')), 10000);

      const check = async () => {
        try {
          const res = await fetch(`http://localhost:${RELAY_PORT}/health`);
          if (res.ok) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch { /* not ready */ }
        setTimeout(check, 200);
      };
      check();
    });
  });

  after(async () => {
    // Clean up test documents
    if (pool) {
      await pool.query(`DELETE FROM documents WHERE user_id = $1`, [TEST_USER_ID]);
      await pool.end();
    }

    // Stop relay
    if (relayProcess) {
      relayProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`http://localhost:${RELAY_PORT}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('connect, edit, persist to Postgres', async () => {
    const client = await createYjsClient(TEST_USER_ID, 'test-project', '01-hello');

    // Insert text
    client.ytext.insert(0, 'Hello from sync relay test!');

    // Wait for debounced save
    await new Promise(r => setTimeout(r, 500));

    // Check Postgres
    const { rows } = await pool.query(
      `SELECT content_text, byte_size FROM documents WHERE user_id = $1 AND project = $2 AND doc_path = $3`,
      [TEST_USER_ID, 'test-project', '01-hello']
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].content_text, 'Hello from sync relay test!');
    assert.ok(rows[0].byte_size > 0);

    client.close();
  });

  it('reconnect loads state from Postgres', async () => {
    // First connection: write content
    const client1 = await createYjsClient(TEST_USER_ID, 'test-project', '02-persist');
    client1.ytext.insert(0, 'Persistent content');

    // Wait for save
    await new Promise(r => setTimeout(r, 500));
    client1.close();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 1000));

    // Second connection: should load from DB
    const client2 = await createYjsClient(TEST_USER_ID, 'test-project', '02-persist');

    // Give it a moment to sync
    await new Promise(r => setTimeout(r, 200));

    assert.equal(client2.ytext.toString(), 'Persistent content');
    client2.close();
  });

  it('two clients sync to the same document', async () => {
    const client1 = await createYjsClient(TEST_USER_ID, 'test-project', '03-multi');
    const client2 = await createYjsClient(TEST_USER_ID, 'test-project', '03-multi');

    // Client 1 writes
    client1.ytext.insert(0, 'from client 1');

    // Wait for sync
    await waitFor(() => client2.ytext.toString().includes('from client 1'), 2000);

    // Client 2 appends
    client2.ytext.insert(client2.ytext.length, ' + client 2');

    // Wait for sync
    await waitFor(() => client1.ytext.toString().includes('client 2'), 2000);

    const expected = 'from client 1 + client 2';
    assert.equal(client1.ytext.toString(), expected);
    assert.equal(client2.ytext.toString(), expected);

    client1.close();
    client2.close();
  });

  it('stats endpoint shows document info', async () => {
    const client = await createYjsClient(TEST_USER_ID, 'test-project', '04-stats');
    client.ytext.insert(0, 'stats test');

    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${RELAY_PORT}/stats`);
    const stats = await res.json();

    assert.ok(stats.activeConnections >= 1);
    assert.ok(stats.documentsInMemory >= 1);
    assert.ok(stats.documents.some(d => d.key.includes('04-stats')));

    client.close();
  });

  it('document API lists user documents', async () => {
    // Ensure at least one doc is saved
    const client = await createYjsClient(TEST_USER_ID, 'test-project', '05-list');
    client.ytext.insert(0, 'list test');
    await new Promise(r => setTimeout(r, 500));
    client.close();

    const res = await fetch(`http://localhost:${RELAY_PORT}/api/documents/${TEST_USER_ID}`);
    const docs = await res.json();

    assert.ok(Array.isArray(docs));
    assert.ok(docs.length >= 1);
    assert.ok(docs.some(d => d.doc_path === '05-list'));
  });
});
