import { json, type Queryable } from '../db/client.js';
import { flattenRow, rowKey, type Cell, type Row } from './rows.js';

export interface Dataset {
  id: number;
  name: string;
  kind: string;
  source: Record<string, unknown>;
  row_count: number;
  created_at: string;
  updated_at: string;
}

/** An error whose message is safe to show to the model as it is. */
export class ToolError extends Error {}

const DATASET_FIELDS = 'id, name, kind, source, row_count, created_at, updated_at';

export async function createDataset(
  q: Queryable,
  workspaceId: string,
  input: { name: string; kind: string; source?: Record<string, unknown>; day?: string },
): Promise<Dataset> {
  const res = await q.query<Dataset>(
    `insert into datasets (workspace_id, name, kind, source, day) values ($1, $2, $3, $4::jsonb, $5)
     returning ${DATASET_FIELDS}`,
    [workspaceId, input.name.slice(0, 200), input.kind, json(input.source ?? {}), input.day ?? null],
  );
  return res.rows[0]!;
}

/** Finds a dataset by its ID or its exact name. Datasets of other workspaces are never found. */
export async function getDataset(q: Queryable, workspaceId: string, ref: string | number): Promise<Dataset> {
  const asId = typeof ref === 'number' ? ref : /^\d+$/.test(ref.trim()) ? Number(ref) : null;
  const res =
    asId !== null
      ? await q.query<Dataset>(`select ${DATASET_FIELDS} from datasets where workspace_id = $1 and id = $2`, [workspaceId, asId])
      : await q.query<Dataset>(
          `select ${DATASET_FIELDS} from datasets where workspace_id = $1 and lower(name) = lower($2) order by id desc limit 1`,
          [workspaceId, String(ref).trim()],
        );
  const found = res.rows[0];
  if (!found) throw new ToolError(`No dataset "${ref}" in this workspace. list_datasets shows the ones that exist.`);
  return found;
}

export async function listDatasets(q: Queryable, workspaceId: string, limit = 50): Promise<Dataset[]> {
  const res = await q.query<Dataset>(
    `select ${DATASET_FIELDS} from datasets where workspace_id = $1 order by updated_at desc, id desc limit $2`,
    [workspaceId, limit],
  );
  return res.rows;
}

export async function deleteDataset(q: Queryable, workspaceId: string, id: number): Promise<void> {
  await q.query('delete from datasets where workspace_id = $1 and id = $2', [workspaceId, id]);
}

/** One dataset per day collects the replies that were small enough to go straight to the model. */
export async function dailyDataset(q: Queryable, workspaceId: string, day: string): Promise<Dataset> {
  const found = await q.query<Dataset>(
    `select ${DATASET_FIELDS} from datasets where workspace_id = $1 and kind = 'daily' and day = $2 order by id limit 1`,
    [workspaceId, day],
  );
  return found.rows[0] ?? createDataset(q, workspaceId, { name: `Quick calls ${day}`, kind: 'daily', day });
}

/**
 * Adds rows to the end of a dataset. The row counter is bumped first, in one statement, so two
 * chunks of the same pull can never hand out the same row numbers.
 */
export async function appendRows(
  q: Queryable,
  workspaceId: string,
  datasetId: number,
  rows: Array<{ key?: string | null; data: Row }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const bumped = await q.query<{ row_count: number }>(
    'update datasets set row_count = row_count + $1, updated_at = now() where id = $2 and workspace_id = $3 returning row_count',
    [rows.length, datasetId, workspaceId],
  );
  const end = bumped.rows[0]?.row_count;
  if (end === undefined) throw new ToolError('That dataset no longer exists.');
  const start = end - rows.length;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const payload = slice.map((row, j) => ({
      n: start + i + j + 1,
      k: row.key === undefined ? rowKey(row.data) : row.key,
      d: row.data,
    }));
    await q.query(
      `insert into dataset_rows (dataset_id, workspace_id, row_no, key, data)
       select $1, $2, (x->>'n')::int, x->>'k', x->'d' from jsonb_array_elements($3::jsonb) x`,
      [datasetId, workspaceId, json(payload)],
    );
  }
  return rows.length;
}

/** Adds fetched fields to the rows that have the given key. Existing fields are kept. */
export async function mergeIntoRows(
  q: Queryable,
  workspaceId: string,
  datasetId: number,
  patches: Array<{ key: string; data: Row }>,
): Promise<void> {
  if (patches.length === 0) return;
  await q.query(
    `update dataset_rows r set data = r.data || (x->'d')
       from jsonb_array_elements($3::jsonb) x
      where r.dataset_id = $1 and r.workspace_id = $2 and r.key = x->>'k'`,
    [datasetId, workspaceId, json(patches.map((p) => ({ k: p.key, d: p.data })))],
  );
  await q.query('update datasets set updated_at = now() where id = $1 and workspace_id = $2', [datasetId, workspaceId]);
}

export async function existingKeys(q: Queryable, workspaceId: string, datasetId: number, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const res = await q.query<{ key: string }>(
    'select key from dataset_rows where dataset_id = $1 and workspace_id = $2 and key = any($3::text[])',
    [datasetId, workspaceId, keys],
  );
  return new Set(res.rows.map((r) => r.key));
}

export interface ColumnInfo {
  name: string;
  /** Share of sampled rows that have a value, from 0 to 1. */
  filled: number;
  /** Where the column came from. */
  origin: string;
}

const SAMPLE_ROWS = 500;

/**
 * Lists a dataset's columns with how full each one is. It reads the first 500 rows, which is
 * enough to describe a dataset without scanning 10,000 rows on every call.
 */
export async function describeColumns(q: Queryable, workspaceId: string, datasetId: number): Promise<{ columns: ColumnInfo[]; sampled: number }> {
  const sample = await q.query<{ data: Row; extra: Row }>(
    'select data, extra from dataset_rows where dataset_id = $1 and workspace_id = $2 order by row_no limit $3',
    [datasetId, workspaceId, SAMPLE_ROWS],
  );
  const added = await q.query<{ name: string; kind: string; definition: Record<string, unknown> }>(
    'select name, kind, definition from dataset_columns where dataset_id = $1 and workspace_id = $2',
    [datasetId, workspaceId],
  );
  const addedBy = new Map(added.rows.map((c) => [c.name, c]));
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of sample.rows) {
    const flat = { ...flattenRow(row.data), ...flattenRow(row.extra) };
    for (const [name, value] of Object.entries(flat)) {
      if (!counts.has(name)) {
        counts.set(name, 0);
        order.push(name);
      }
      if (value !== null && value !== '') counts.set(name, counts.get(name)! + 1);
    }
  }
  for (const name of addedBy.keys()) {
    if (!counts.has(name)) {
      counts.set(name, 0);
      order.push(name);
    }
  }
  const total = Math.max(1, sample.rows.length);
  const columns = order.map((name) => {
    const meta = addedBy.get(name);
    const origin = !meta
      ? 'CreatorDB'
      : meta.kind === 'formula'
        ? `formula: ${String(meta.definition.formula ?? '')}`
        : `verdict: ${String(meta.definition.rubric ?? '').slice(0, 80)}`;
    return { name, filled: counts.get(name)! / total, origin };
  });
  return { columns, sampled: sample.rows.length };
}

/** Reads rows in order, a batch at a time, as flat cells for the given columns. */
export async function* readFlatRows(
  q: Queryable,
  workspaceId: string,
  datasetId: number,
  batch = 2000,
): AsyncGenerator<Array<{ row_no: number; flat: Record<string, Cell> }>> {
  let after = 0;
  for (;;) {
    const res = await q.query<{ row_no: number; data: Row; extra: Row }>(
      'select row_no, data, extra from dataset_rows where dataset_id = $1 and workspace_id = $2 and row_no > $3 order by row_no limit $4',
      [datasetId, workspaceId, after, batch],
    );
    if (res.rows.length === 0) return;
    yield res.rows.map((r) => ({ row_no: r.row_no, flat: { ...flattenRow(r.data), ...flattenRow(r.extra) } }));
    after = res.rows[res.rows.length - 1]!.row_no;
  }
}
