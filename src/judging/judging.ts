import type { Config } from '../config.js';
import { json, type Queryable } from '../db/client.js';
import { ToolError, type Dataset } from '../workspace/datasets.js';
import { compileFilter, Params } from '../workspace/formula.js';
import { defaultColumns, queryRows, type QueryOutput } from '../workspace/query.js';

export interface JudgingSetup {
  rubric: string;
  choices: string[];
  show: string[];
  where?: string;
}

export interface Batch {
  id: number;
  rows: QueryOutput;
  setup: JudgingSetup;
  left: number;
}

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

/**
 * Hands out the next creators to judge. The server runs no language model: the customer's own
 * Claude reads each batch and sends verdicts back.
 *
 * A batch is reserved for a while. If its verdicts never arrive, for example because the chat
 * closed, the rows go back in line. Reservations also let several readers share one queue
 * without judging any creator twice.
 */
export async function nextBatch(
  q: Queryable,
  cfg: Config,
  workspaceId: string,
  dataset: Dataset,
  input: { column: string; size: number; rubric?: string; choices?: string[]; show?: string[]; where?: string },
): Promise<Batch | { done: true; judged: number }> {
  if (!COLUMN_NAME.test(input.column)) throw new ToolError('The verdict column name uses letters, digits and underscores only.');

  // The rubric is kept with the column, so every batch and every chat judges by the same rules.
  const existing = await q.query<{ kind: string; definition: JudgingSetup }>(
    'select kind, definition from dataset_columns where dataset_id = $1 and workspace_id = $2 and name = $3',
    [dataset.id, workspaceId, input.column],
  );
  let setup = existing.rows[0]?.kind === 'verdict' ? existing.rows[0].definition : undefined;
  if (existing.rows[0] && existing.rows[0].kind !== 'verdict') {
    throw new ToolError(`"${input.column}" is already a formula column. Pick another name for the verdicts.`);
  }
  if (input.rubric) {
    setup = {
      rubric: input.rubric,
      choices: input.choices?.length ? input.choices : (setup?.choices ?? ['fit', 'maybe', 'not_fit']),
      show: input.show?.length ? input.show : (setup?.show ?? (await defaultColumns(q, workspaceId, dataset.id, 8))),
      where: input.where ?? setup?.where,
    };
    await q.query(
      `insert into dataset_columns (dataset_id, workspace_id, name, kind, definition) values ($1, $2, $3, 'verdict', $4::jsonb)
       on conflict (dataset_id, name) do update set definition = excluded.definition`,
      [dataset.id, workspaceId, input.column, json(setup)],
    );
  }
  if (!setup) throw new ToolError('The first batch needs a rubric: the rules a creator must meet. Later batches reuse it.');

  await q.query("update judging_batches set status = 'expired' where workspace_id = $1 and status = 'open' and reserved_until < now()", [workspaceId]);

  const p = new Params([dataset.id, workspaceId]);
  const column = p.add([input.column]);
  const filter = setup.where?.trim() ? compileFilter(setup.where, p) : 'true';
  const picked = await q.query<{ row_no: number }>(
    `select r.row_no from dataset_rows r
      where r.dataset_id = $1 and r.workspace_id = $2
        and (r.extra #>> ${column}::text[]) is null
        and ${filter}
        and not exists (
          select 1 from judging_batches b
           where b.dataset_id = r.dataset_id and b.column_name = ${p.add(input.column)} and b.status = 'open'
             and r.row_no = any(b.row_nos))
      order by r.row_no
      limit ${p.add(input.size)}`,
    p.values,
  );
  const rowNos = picked.rows.map((r) => r.row_no);
  if (rowNos.length === 0) {
    const judged = await q.query<{ n: number }>(
      'select count(*) as n from dataset_rows r where r.dataset_id = $1 and r.workspace_id = $2 and (r.extra #>> $3::text[]) is not null',
      [dataset.id, workspaceId, [input.column]],
    );
    return { done: true, judged: Number(judged.rows[0]?.n ?? 0) };
  }

  const batch = await q.query<{ id: number }>(
    `insert into judging_batches (workspace_id, dataset_id, column_name, row_nos, reserved_until)
     values ($1, $2, $3, $4::int[], now() + ($5::int * interval '1 second')) returning id`,
    [workspaceId, dataset.id, input.column, rowNos, cfg.judgingReserveSec],
  );
  const rows = await queryRows(q, workspaceId, dataset, {
    where: `row in (${rowNos.join(', ')})`,
    columns: setup.show,
    limit: rowNos.length,
  });
  const leftParams = new Params([dataset.id, workspaceId]);
  const leftColumn = leftParams.add([input.column]);
  const leftFilter = setup.where?.trim() ? compileFilter(setup.where, leftParams) : 'true';
  const left = await q.query<{ n: number }>(
    `select count(*) as n from dataset_rows r
      where r.dataset_id = $1 and r.workspace_id = $2 and (r.extra #>> ${leftColumn}::text[]) is null and ${leftFilter}`,
    leftParams.values,
  );
  return { id: batch.rows[0]!.id, rows, setup, left: Number(left.rows[0]?.n ?? 0) };
}

export interface Verdict {
  row: number;
  verdict: string;
  note?: string;
}

/** Saves a batch of verdicts. A batch with rows missing, or with a verdict outside the choices, is refused whole. */
export async function submitVerdicts(q: Queryable, workspaceId: string, batchId: number, verdicts: Verdict[]): Promise<{ saved: number; dataset_id: number; column: string }> {
  const found = await q.query<{ dataset_id: number; column_name: string; row_nos: number[]; status: string }>(
    'select dataset_id, column_name, row_nos, status from judging_batches where id = $1 and workspace_id = $2',
    [batchId, workspaceId],
  );
  const batch = found.rows[0];
  if (!batch) throw new ToolError(`No batch ${batchId} in this workspace.`);
  if (batch.status === 'done') throw new ToolError(`Batch ${batchId} was already submitted.`);

  const setupRow = await q.query<{ definition: JudgingSetup }>(
    'select definition from dataset_columns where dataset_id = $1 and workspace_id = $2 and name = $3',
    [batch.dataset_id, workspaceId, batch.column_name],
  );
  const choices = setupRow.rows[0]?.definition.choices ?? [];
  const given = new Map(verdicts.map((v) => [v.row, v]));
  const missing = batch.row_nos.filter((n) => !given.has(n));
  if (missing.length) throw new ToolError(`Nothing was saved: the batch is missing verdicts for rows ${missing.join(', ')}. Send every row of the batch.`);
  const extra = verdicts.filter((v) => !batch.row_nos.includes(v.row)).map((v) => v.row);
  if (extra.length) throw new ToolError(`Nothing was saved: rows ${extra.join(', ')} are not in batch ${batchId}.`);
  const bad = verdicts.filter((v) => !choices.includes(v.verdict));
  if (bad.length) {
    throw new ToolError(`Nothing was saved: "${bad[0]!.verdict}" is not one of the allowed verdicts (${choices.join(', ')}).`);
  }

  const noteColumn = `${batch.column_name}_note`;
  await q.query(
    `update dataset_rows r
        set extra = r.extra
          || jsonb_build_object($3::text, x->>'verdict')
          || case when coalesce(x->>'note', '') = '' then '{}'::jsonb else jsonb_build_object($4::text, x->>'note') end
       from jsonb_array_elements($5::jsonb) x
      where r.dataset_id = $1 and r.workspace_id = $2 and r.row_no = (x->>'row')::int`,
    [batch.dataset_id, workspaceId, batch.column_name, noteColumn, json(verdicts)],
  );
  await q.query("update judging_batches set status = 'done' where id = $1 and workspace_id = $2", [batchId, workspaceId]);
  await q.query('update datasets set updated_at = now() where id = $1 and workspace_id = $2', [batch.dataset_id, workspaceId]);
  return { saved: verdicts.length, dataset_id: batch.dataset_id, column: batch.column_name };
}
