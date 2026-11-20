import type { Queryable } from '../db/client.js';
import { describeColumns, ToolError, type Dataset } from './datasets.js';
import { compileAggregate, compileFilter, compileFormula, compileSortKey, compileToJson, Params } from './formula.js';
import { flattenRow, type Cell, type Row } from './rows.js';

export interface SortSpec {
  by: string;
  desc?: boolean;
}

export interface QueryInput {
  where?: string;
  columns?: string[];
  sort?: SortSpec[];
  limit: number;
  offset?: number;
}

export interface QueryOutput {
  columns: string[];
  rows: Cell[][];
  /** Rows that match the filter, before the limit. */
  matched: number;
}

function orderBy(sort: SortSpec[] | undefined, p: Params): string {
  const parts: string[] = [];
  for (const s of sort ?? []) {
    const key = compileSortKey(s.by, p);
    const dir = s.desc ? 'desc' : 'asc';
    parts.push(`${key.num} ${dir} nulls last`);
    if (key.text !== 'null') parts.push(`${key.text} ${dir} nulls last`);
  }
  parts.push('r.row_no asc');
  return parts.join(', ');
}

/** The columns shown when none are named: the row's key, then the fullest simple columns. */
export async function defaultColumns(q: Queryable, workspaceId: string, datasetId: number, max = 8): Promise<string[]> {
  const { columns } = await describeColumns(q, workspaceId, datasetId);
  // Who, how big, how they are doing lately, then where. Names a dataset doesn't have are skipped.
  const preferred = [
    'uniqueId', 'channelId', 'displayName', 'name', 'totalFollowers', 'totalSubscribers', 'followers',
    'medianViews', 'engagementRate', 'country', 'mainLanguage', 'language', 'platform', 'vet_status',
  ];
  const names = columns.map((c) => c.name);
  const picked = preferred.filter((n) => names.includes(n));
  const added = columns.filter((c) => c.origin !== 'CreatorDB').map((c) => c.name);
  const rest = columns
    .filter((c) => c.origin === 'CreatorDB' && !picked.includes(c.name) && !/url|avatar|thumbnail|image/i.test(c.name))
    .sort((a, b) => b.filled - a.filled)
    .map((c) => c.name);
  return [...new Set([...picked, ...added, ...rest])].slice(0, max);
}

/** Filters, sorts and pages a dataset. Every row carries its row number first. */
export async function queryRows(q: Queryable, workspaceId: string, dataset: Dataset, input: QueryInput): Promise<QueryOutput> {
  const p = new Params([dataset.id, workspaceId]);
  const where = input.where?.trim() ? compileFilter(input.where, p) : 'true';
  const order = orderBy(input.sort, p);
  const limit = p.add(input.limit);
  const offset = p.add(input.offset ?? 0);
  const res = await q.query<{ row_no: number; data: Row; extra: Row; matched: number }>(
    `select r.row_no, r.data, r.extra, count(*) over() as matched
       from dataset_rows r
      where r.dataset_id = $1 and r.workspace_id = $2 and ${where}
      order by ${order}
      limit ${limit} offset ${offset}`,
    p.values,
  );
  const columns = input.columns?.length ? input.columns : await defaultColumns(q, workspaceId, dataset.id);
  const rows = res.rows.map((r) => {
    const flat = { ...flattenRow(r.data), ...flattenRow(r.extra) };
    return [r.row_no, ...columns.map((c) => pick(flat, r, c))];
  });
  let matched = Number(res.rows[0]?.matched ?? 0);
  // With no rows on this page (limit 0, or an offset past the end) the window count is missing.
  if (res.rows.length === 0) matched = await countRows(q, workspaceId, dataset, input.where);
  return { columns: ['row', ...columns], rows, matched };
}

/** A column's value. A name that points at a nested object or list returns it as JSON text. */
function pick(flat: Record<string, Cell>, r: { data: Row; extra: Row }, name: string): Cell {
  if (name in flat) return flat[name] ?? null;
  let value: unknown = name in r.extra ? r.extra[name] : r.data;
  if (!(name in r.extra)) {
    for (const part of name.split('.')) {
      if (typeof value !== 'object' || value === null) return null;
      value = (value as Row)[part];
    }
  }
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : (value as Cell);
}

export async function countRows(q: Queryable, workspaceId: string, dataset: Dataset, where?: string): Promise<number> {
  const p = new Params([dataset.id, workspaceId]);
  const filter = where?.trim() ? compileFilter(where, p) : 'true';
  const res = await q.query<{ n: number }>(
    `select count(*) as n from dataset_rows r where r.dataset_id = $1 and r.workspace_id = $2 and ${filter}`,
    p.values,
  );
  return Number(res.rows[0]?.n ?? 0);
}

export interface Measure {
  fn: string;
  of?: string;
  as?: string;
}

/** Totals for a dataset, optionally split into groups. */
export async function aggregate(
  q: Queryable,
  workspaceId: string,
  dataset: Dataset,
  input: { where?: string; groupBy?: string[]; measures: Measure[]; limit: number },
): Promise<QueryOutput> {
  const p = new Params([dataset.id, workspaceId]);
  const where = input.where?.trim() ? compileFilter(input.where, p) : 'true';
  const groups = (input.groupBy ?? []).map((g) => {
    const c = compileFormula(g, p);
    return c.type === 'any' || c.type === 'text' ? c.sql : `(${c.sql})::text`;
  });
  if (input.measures.length === 0) throw new ToolError('Name at least one measure, for example { fn: "count" }.');
  const measures = input.measures.map((m) => compileAggregate(m.fn, m.of, p));
  const select = [...groups.map((g, i) => `${g} as g${i}`), ...measures.map((m, i) => `${m} as m${i}`)];
  const groupClause = groups.length ? `group by ${groups.map((_, i) => i + 1).join(', ')}` : '';
  const res = await q.query<Record<string, unknown>>(
    `select ${select.join(', ')}
       from dataset_rows r
      where r.dataset_id = $1 and r.workspace_id = $2 and ${where}
      ${groupClause}
      order by ${measures.length ? `m0 desc nulls last` : '1'}
      limit ${p.add(input.limit)}`,
    p.values,
  );
  const columns = [
    ...(input.groupBy ?? []),
    ...input.measures.map((m) => m.as ?? (m.of ? `${m.fn}(${m.of})` : m.fn)),
  ];
  const rows = res.rows.map((r) => [
    ...groups.map((_, i) => (r[`g${i}`] ?? null) as Cell),
    ...measures.map((_, i) => {
      const v = r[`m${i}`];
      return v === null || v === undefined ? null : Math.round(Number(v) * 10000) / 10000;
    }),
  ]);
  return { columns, rows, matched: rows.length };
}

const RESERVED_COLUMN = /^(row|key|handle|followers)$/i;

/** Fills a new column from a formula, on the server, for every row of the dataset. */
export async function addFormulaColumn(
  q: Queryable,
  workspaceId: string,
  dataset: Dataset,
  name: string,
  formula: string,
): Promise<number> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(name)) {
    throw new ToolError('A column name starts with a letter and uses only letters, digits and underscores (60 at most).');
  }
  if (RESERVED_COLUMN.test(name)) throw new ToolError(`"${name}" is a built-in name. Pick another column name.`);
  const p = new Params([dataset.id, workspaceId]);
  const value = compileToJson(formula, p);
  const res = await q.query(
    `update dataset_rows r set extra = jsonb_set(r.extra, ${p.add([name])}::text[], coalesce(${value}, 'null'::jsonb))
      where r.dataset_id = $1 and r.workspace_id = $2`,
    p.values,
  );
  await q.query(
    `insert into dataset_columns (dataset_id, workspace_id, name, kind, definition) values ($1, $2, $3, 'formula', $4::jsonb)
     on conflict (dataset_id, name) do update set kind = 'formula', definition = excluded.definition, created_at = now()`,
    [dataset.id, workspaceId, name, JSON.stringify({ formula })],
  );
  await q.query('update datasets set updated_at = now() where id = $1 and workspace_id = $2', [dataset.id, workspaceId]);
  return res.rowCount;
}
