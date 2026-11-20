import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run several statements in one transaction, as the database owner. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /**
   * Run statements for one workspace. The transaction switches to the restricted `app_user` role
   * and names the workspace, so Postgres itself refuses rows that belong to anyone else.
   */
  asWorkspace<T>(workspaceId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCOPE_SQL = 'set local role app_user';
const SCOPE_SETTING = "select set_config('app.workspace_id', $1, true)";

/** Postgres returns numeric and bigint as text. The server only stores values that fit a double. */
const NUMERIC_OID = 1700;
const INT8_OID = 20;

async function openPg(databaseUrl: string): Promise<Db> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(NUMERIC_OID, (v: string) => Number(v));
  pg.types.setTypeParser(INT8_OID, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  async function run<T>(scope: string | null, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    const q: Queryable = {
      async query<R>(sql: string, params: unknown[] = []) {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
      },
    };
    try {
      await client.query('begin');
      if (scope !== null) {
        await client.query(SCOPE_SQL);
        await client.query(SCOPE_SETTING, [scope]);
      }
      const out = await fn(q);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    tx: (fn) => run(null, fn),
    asWorkspace: (workspaceId, fn) => run(workspaceId, fn),
    close: () => pool.end(),
  };
}

async function openEmbedded(dataDir: string | null): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const parsers = { [NUMERIC_OID]: (v: string) => Number(v), [INT8_OID]: (v: string) => Number(v) };
  let dir: string | undefined;
  if (dataDir) {
    dir = join(dataDir, 'pg');
    mkdirSync(dir, { recursive: true });
  }
  // The options go in as one object. Passed separately, the parsers are ignored.
  const db = new PGlite({ dataDir: dir, parsers });
  await db.waitReady;

  type Runner = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> };
  const wrap = (runner: Runner): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await runner.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
    },
  });

  const base = wrap(db as unknown as Runner);
  return {
    query: base.query,
    tx: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as Runner))) as Promise<never>,
    asWorkspace: (workspaceId, fn) =>
      db.transaction(async (tx) => {
        await tx.exec(SCOPE_SQL);
        await tx.query(SCOPE_SETTING, [workspaceId]);
        return fn(wrap(tx as unknown as Runner));
      }) as Promise<never>,
    close: () => db.close(),
  };
}

/** Opens Postgres when `DATABASE_URL` is set, and an embedded Postgres in the data folder otherwise. */
export async function openDb(cfg: Pick<Config, 'databaseUrl' | 'dataDir'>, opts: { memory?: boolean } = {}): Promise<Db> {
  if (cfg.databaseUrl) return openPg(cfg.databaseUrl);
  return openEmbedded(opts.memory ? null : cfg.dataDir);
}

/** Every jsonb value goes in as text with a `::jsonb` cast, so both drivers treat arrays the same way. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
