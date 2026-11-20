import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  /** Public address of this server, with no trailing slash. File links and sign-in use it. */
  publicUrl: string;
  /** Postgres connection string. When empty, an embedded Postgres in `dataDir` is used. */
  databaseUrl: string;
  dataDir: string;
  /** The real CreatorDB API. */
  upstreamBase: string;
  /** Seals sign-in codes, encrypts stored API keys and signs file links. */
  tokenSecret: string;
  /** A reply with more rows than this comes back as a summary and a file. */
  replyRowLimit: number;
  /** How long a whole-list pull may hold its tool call open before it reports progress. */
  pullWaitMs: number;
  chunkSize: number;
  /** Chunks of one workspace that may run at the same time. */
  chunksPerWorkspace: number;
  /** Creators handled at the same time inside one chunk. */
  callsPerChunk: number;
  /** CreatorDB requests one workspace may have in flight. */
  maxInFlight: number;
  /** In-flight slots that whole-list pulls must leave free for quick lookups. */
  lookupReserve: number;
  maxTries: number;
  backoffBaseMs: number;
  requestTimeoutMs: number;
  fileLinkTtlSec: number;
  accessTokenTtlSec: number;
  refreshIdleTtlSec: number;
  judgingReserveSec: number;
  /** Largest search a whole-list pull will page through. */
  maxSearchResults: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

/** A secret kept in the data folder, so a local server survives restarts without any setup. */
function devSecret(dataDir: string): string {
  const file = join(dataDir, 'dev-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = num(env.PORT, 8787);
  const dataDir = resolve(env.DATA_DIR || './data');
  const production = env.NODE_ENV === 'production';
  if (production && !env.TOKEN_SECRET) {
    throw new Error('TOKEN_SECRET is required when NODE_ENV=production');
  }
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL || '',
    dataDir,
    upstreamBase: (env.CREATORDB_UPSTREAM || 'https://apiv3.creatordb.app').replace(/\/+$/, ''),
    tokenSecret: env.TOKEN_SECRET || devSecret(dataDir),
    replyRowLimit: num(env.REPLY_ROW_LIMIT, 50),
    pullWaitMs: num(env.PULL_WAIT_MS, 110_000),
    chunkSize: num(env.CHUNK_SIZE, 100),
    chunksPerWorkspace: num(env.CHUNKS_PER_WORKSPACE, 3),
    callsPerChunk: num(env.CALLS_PER_CHUNK, 4),
    maxInFlight: num(env.MAX_IN_FLIGHT, 14),
    lookupReserve: num(env.LOOKUP_RESERVE, 2),
    maxTries: num(env.MAX_TRIES, 6),
    backoffBaseMs: num(env.BACKOFF_BASE_MS, 1000),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 60_000),
    fileLinkTtlSec: num(env.FILE_LINK_TTL_SEC, 24 * 60 * 60),
    accessTokenTtlSec: num(env.ACCESS_TOKEN_TTL_SEC, 60 * 60),
    refreshIdleTtlSec: num(env.REFRESH_IDLE_TTL_SEC, 90 * 24 * 60 * 60),
    judgingReserveSec: num(env.JUDGING_RESERVE_SEC, 15 * 60),
    maxSearchResults: num(env.MAX_SEARCH_RESULTS, 10_000),
  };
}
