import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { open, seal, sha256 } from './crypto.js';

const KEY_PURPOSE = 'api-key';

/**
 * A workspace belongs to one CreatorDB API key. The key is stored encrypted, because a
 * whole-list pull keeps running after the request that started it has ended.
 *
 * Encryption here uses the server's own secret. A production deployment can swap these two
 * functions for a cloud key service without touching anything else.
 */
function encryptKey(cfg: Config, apiKey: string): string {
  return seal(cfg.tokenSecret, KEY_PURPOSE, { k: apiKey });
}
function decryptKey(cfg: Config, cipher: string): string {
  return open<{ k: string }>(cfg.tokenSecret, KEY_PURPOSE, cipher).k;
}

export async function findWorkspace(db: Db, apiKey: string): Promise<string | null> {
  const res = await db.query<{ id: string }>('select id from workspaces where key_hash = $1', [sha256(apiKey)]);
  return res.rows[0]?.id ?? null;
}

/** Returns the workspace for a key, creating it the first time the key is seen. */
export async function ensureWorkspace(db: Db, cfg: Config, apiKey: string): Promise<string> {
  const hash = sha256(apiKey);
  const res = await db.query<{ id: string }>(
    `insert into workspaces (id, key_hash, key_cipher, last_seen_at) values ($1, $2, $3, now())
     on conflict (key_hash) do update set last_seen_at = now()
     returning id`,
    [randomUUID(), hash, encryptKey(cfg, apiKey)],
  );
  return res.rows[0]!.id;
}

export async function workspaceKey(db: Db, cfg: Config, workspaceId: string): Promise<string> {
  const res = await db.query<{ key_cipher: string }>('select key_cipher from workspaces where id = $1', [workspaceId]);
  const row = res.rows[0];
  if (!row) throw new Error('workspace not found');
  return decryptKey(cfg, row.key_cipher);
}

/** Checks a key with CreatorDB's free usage call. Used before a new workspace is created. */
export async function keyIsValid(cfg: Config, upstream: typeof fetch, apiKey: string): Promise<boolean> {
  try {
    const res = await upstream(`${cfg.upstreamBase}/usage`, {
      method: 'GET',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return false;
    const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return res.ok && body?.success !== false;
  } catch {
    return false;
  }
}
