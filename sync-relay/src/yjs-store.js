/**
 * Yjs state persistence via Postgres.
 *
 * Stores Yjs document state (binary) and plain text snapshot
 * in the `documents` table. Supports load/save with debounced writes.
 */

import { query } from './db.js';
import { createHash } from 'crypto';

/**
 * Load Yjs state from Postgres.
 * @returns {{ yjsState: Uint8Array|null, contentText: string|null }}
 */
export async function loadDocument(userId, project, docPath) {
  const { rows } = await query(
    `SELECT yjs_state, content_text FROM documents
     WHERE user_id = $1 AND project = $2 AND doc_path = $3`,
    [userId, project, docPath]
  );

  if (rows.length === 0) {
    return { yjsState: null, contentText: null };
  }

  return {
    yjsState: rows[0].yjs_state ? new Uint8Array(rows[0].yjs_state) : null,
    contentText: rows[0].content_text,
  };
}

/**
 * Save Yjs state to Postgres (upsert).
 */
export async function saveDocument(userId, project, docPath, yjsState, contentText) {
  const hash = createHash('md5').update(contentText || '').digest('hex');
  const byteSize = yjsState ? yjsState.byteLength : 0;

  await query(
    `INSERT INTO documents (user_id, project, doc_path, yjs_state, content_text, content_hash, byte_size, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, project, doc_path)
     DO UPDATE SET yjs_state = $4, content_text = $5, content_hash = $6, byte_size = $7, updated_at = NOW()`,
    [userId, project, docPath, Buffer.from(yjsState), contentText, hash, byteSize]
  );
}

/**
 * List all documents for a user.
 */
export async function listUserDocuments(userId) {
  const { rows } = await query(
    `SELECT project, doc_path, content_hash, byte_size, updated_at, created_at
     FROM documents WHERE user_id = $1
     ORDER BY project, doc_path`,
    [userId]
  );
  return rows;
}

/**
 * List documents in a specific project.
 */
export async function listProjectDocuments(userId, project) {
  const { rows } = await query(
    `SELECT doc_path, content_hash, byte_size, updated_at, created_at
     FROM documents WHERE user_id = $1 AND project = $2
     ORDER BY doc_path`,
    [userId, project]
  );
  return rows;
}

/**
 * Delete a document.
 */
export async function deleteDocument(userId, project, docPath) {
  await query(
    `DELETE FROM documents WHERE user_id = $1 AND project = $2 AND doc_path = $3`,
    [userId, project, docPath]
  );
}
