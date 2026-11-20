import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { readFlatRows, type Dataset } from './datasets.js';
import { countRows, queryRows } from './query.js';
import { toCsv, type Cell } from './rows.js';

export interface ResultFile {
  id: string;
  name: string;
  url: string;
  bytes: number;
  rows: number;
  expiresAt: Date;
}

function sign(cfg: Config, fileId: string, expires: number): string {
  return createHmac('sha256', cfg.tokenSecret).update(`file:${fileId}:${expires}`).digest('base64url');
}

/** A link that works for anyone who holds it until it expires. The signature covers the expiry. */
export function fileUrl(cfg: Config, fileId: string, expires: number): string {
  return `${cfg.publicUrl}/files/${fileId}?expires=${expires}&sig=${sign(cfg, fileId, expires)}`;
}

export function verifyFileLink(cfg: Config, fileId: string, expires: string | undefined, sig: string | undefined): boolean {
  const exp = Number(expires);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(sign(cfg, fileId, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function fileName(dataset: Dataset): string {
  const base = dataset.name.replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'dataset';
  return `${base} (${dataset.id}).csv`;
}

export function filesDir(cfg: Config): string {
  const dir = join(cfg.dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Writes a dataset to a CSV in file storage and returns an expiring link to it. With a filter or
 * a column list the file holds only those rows and columns. The dataset itself is not changed.
 */
export async function writeDatasetFile(
  deps: { db: Db; cfg: Config },
  workspaceId: string,
  dataset: Dataset,
  opts: { where?: string; columns?: string[] } = {},
): Promise<ResultFile> {
  const { db, cfg } = deps;
  const id = randomUUID();
  const path = join(filesDir(cfg), `${id}.csv`);
  const out = createWriteStream(path, { encoding: 'utf8' });
  let rows = 0;

  const write = async (text: string) => {
    if (!out.write(text)) await once(out, 'drain');
  };

  if (opts.where?.trim()) {
    // A filtered file goes through the same query path as query_dataset, a page at a time.
    const total = await db.asWorkspace(workspaceId, (q) => countRows(q, workspaceId, dataset, opts.where));
    const columns = opts.columns?.length ? opts.columns : await allColumns(db, workspaceId, dataset.id);
    await write(toCsv(['row', ...columns], []));
    for (let offset = 0; offset < total; offset += 1000) {
      const page = await db.asWorkspace(workspaceId, (q) =>
        queryRows(q, workspaceId, dataset, { where: opts.where, columns, limit: 1000, offset }),
      );
      await write(page.rows.map((r) => toCsv([], [r]).slice(1)).join(''));
      rows += page.rows.length;
    }
  } else {
    const columns = opts.columns?.length ? opts.columns : await allColumns(db, workspaceId, dataset.id);
    await write(toCsv(['row', ...columns], []));
    await db.asWorkspace(workspaceId, async (q) => {
      for await (const batch of readFlatRows(q, workspaceId, dataset.id)) {
        const lines: Cell[][] = batch.map((r) => [r.row_no, ...columns.map((c) => r.flat[c] ?? null)]);
        await write(lines.map((l) => toCsv([], [l]).slice(1)).join(''));
        rows += batch.length;
      }
    });
  }

  out.end();
  await once(out, 'finish');
  const bytes = existsSync(path) ? statSync(path).size : 0;
  const expires = Math.floor(Date.now() / 1000) + cfg.fileLinkTtlSec;
  const name = fileName(dataset);
  await db.query(
    'insert into files (id, workspace_id, dataset_id, name, path, bytes, expires_at) values ($1, $2, $3, $4, $5, $6, to_timestamp($7))',
    [id, workspaceId, dataset.id, name, path, bytes, expires],
  );
  return { id, name, url: fileUrl(cfg, id, expires), bytes, rows, expiresAt: new Date(expires * 1000) };
}

/** Every column that appears in any row, in first-seen order. */
async function allColumns(db: Db, workspaceId: string, datasetId: number): Promise<string[]> {
  const seen = new Set<string>();
  await db.asWorkspace(workspaceId, async (q) => {
    for await (const batch of readFlatRows(q, workspaceId, datasetId)) {
      for (const row of batch) for (const name of Object.keys(row.flat)) seen.add(name);
    }
  });
  return [...seen];
}
