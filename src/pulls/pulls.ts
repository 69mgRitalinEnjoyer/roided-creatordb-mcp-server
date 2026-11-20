import { EventEmitter } from 'node:events';
import type { Config } from '../config.js';
import { callContext, isEnvelope, type CallContext } from '../context.js';
import { json, type Db } from '../db/client.js';
import { workspaceKey } from '../auth/workspaces.js';
import { callOfficial, officialHandlers, type OfficialTool, type ToolResult } from '../official/loader.js';
import { describeCall, mainReply } from '../official/replies.js';
import { appendRows, createDataset, existingKeys, getDataset, mergeIntoRows, ToolError, type Dataset } from '../workspace/datasets.js';
import { rowKey, type Row } from '../workspace/rows.js';

export interface PullRequest {
  dataset?: string | number;
  search?: { tool: string; args: Record<string, unknown>; max_results?: number };
  calls: Array<{ tool: string; args?: Record<string, unknown> }>;
  name?: string;
}

export interface Pull {
  id: number;
  workspace_id: string;
  request: PullRequest;
  status: 'running' | 'paused' | 'done' | 'partial' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  credits: number;
  dataset_id: number;
  note: string | null;
  cancel_requested: boolean;
}

type ChunkWork = { type: 'search'; offset: number; pageSize: number; first: boolean } | { type: 'items'; keys: string[] };

interface Chunk {
  id: number;
  pull_id: number;
  workspace_id: string;
  work: ChunkWork;
  size: number;
  tries: number;
}

export interface PullDeps {
  db: Db;
  cfg: Config;
}

const SEARCH_PAGE = 100;
const LOCK_MINUTES = 10;
const PULL_FIELDS = 'id, workspace_id, request, status, total, done, failed, credits, dataset_id, note, cancel_requested';

class OutOfCredits extends Error {}

function looksUpOneCreator(tool: OfficialTool): boolean {
  return 'uniqueId' in tool.shape || 'channelId' in tool.shape;
}

/** The inputs that point an official lookup at one creator. */
function idArgs(tool: OfficialTool, key: string): Record<string, string> {
  if ('channelId' in tool.shape && /^UC[\w-]{22}$/.test(key)) return { channelId: key };
  return { uniqueId: key };
}

function firstText(result: ToolResult): string {
  const item = result.content.find((c) => c.type === 'text') as { text?: string } | undefined;
  return (item?.text ?? 'the call failed').split('\n').slice(0, 2).join(' ').slice(0, 300);
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < items.length && failure === null) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== null) throw failure;
}

/**
 * Starts a whole-list pull. Nothing is estimated and nobody is asked: the work is written down
 * as chunks and the runner picks it up at once.
 */
export async function startPull(deps: PullDeps, runner: PullRunner, workspaceId: string, request: PullRequest): Promise<Pull> {
  const { db, cfg } = deps;
  const tools = await officialHandlers();
  const calls = request.calls ?? [];
  for (const call of calls) {
    const tool = tools.get(call.tool);
    if (!tool) throw new ToolError(`"${call.tool}" is not one of the official tools.`);
    if (!looksUpOneCreator(tool)) throw new ToolError(`${call.tool} doesn't look up one creator, so it can't run over a list.`);
  }
  if (request.search && request.dataset !== undefined) throw new ToolError('Give either a dataset or a search, not both.');
  if (!request.search && request.dataset === undefined) throw new ToolError('Give a dataset to work through, or a search to pull every match of.');

  let pull: Pull;
  if (request.search) {
    const tool = tools.get(request.search.tool);
    if (!tool || !('offset' in tool.shape) || !('pageSize' in tool.shape)) {
      throw new ToolError(`"${request.search.tool}" is not a search that can be paged through. Use search_youtube, search_instagram or search_tiktok.`);
    }
    const args = request.search.args ?? {};
    const offset = Number(args.offset ?? 0) || 0;
    pull = await db.asWorkspace(workspaceId, async (q) => {
      const dataset = await createDataset(q, workspaceId, {
        name: request.name ?? describeCall(request.search!.tool, args),
        kind: 'pull',
        source: { search: request.search, calls },
      });
      const created = await insertPull(q, workspaceId, request, dataset.id, 0);
      await insertChunks(q, created, [{ type: 'search', offset, pageSize: SEARCH_PAGE, first: true }]);
      return created;
    });
  } else {
    if (calls.length === 0) throw new ToolError('Name at least one official call to run on each creator, for example get_instagram_profile.');
    pull = await db.asWorkspace(workspaceId, async (q) => {
      const dataset = await getDataset(q, workspaceId, request.dataset!);
      const keys = await q.query<{ key: string }>(
        'select key from dataset_rows where dataset_id = $1 and workspace_id = $2 and key is not null order by row_no',
        [dataset.id, workspaceId],
      );
      const all = [...new Set(keys.rows.map((r) => r.key))];
      if (all.length === 0) throw new ToolError(`Dataset ${dataset.id} has no creator handles or IDs to work through.`);
      const created = await insertPull(q, workspaceId, request, dataset.id, all.length);
      const work: ChunkWork[] = [];
      for (let i = 0; i < all.length; i += cfg.chunkSize) work.push({ type: 'items', keys: all.slice(i, i + cfg.chunkSize) });
      await insertChunks(q, created, work);
      return created;
    });
  }
  runner.kick();
  return pull;
}

async function insertPull(q: Db | Parameters<Parameters<Db['asWorkspace']>[1]>[0], workspaceId: string, request: PullRequest, datasetId: number, total: number): Promise<Pull> {
  const res = await q.query<Pull>(
    `insert into pulls (workspace_id, kind, request, dataset_id, total) values ($1, 'list', $2::jsonb, $3, $4) returning ${PULL_FIELDS}`,
    [workspaceId, json(request), datasetId, total],
  );
  return res.rows[0]!;
}

async function insertChunks(q: Parameters<Parameters<Db['asWorkspace']>[1]>[0], pull: Pull, work: ChunkWork[]): Promise<void> {
  if (work.length === 0) return;
  await q.query(
    `insert into pull_chunks (pull_id, workspace_id, work, size)
     select $1, $2, x, case when x->>'type' = 'items' then jsonb_array_length(x->'keys') else (x->>'pageSize')::int end
       from jsonb_array_elements($3::jsonb) x`,
    [pull.id, pull.workspace_id, json(work)],
  );
}

export async function getPull(db: Db, workspaceId: string, pullId: number): Promise<Pull> {
  const res = await db.asWorkspace(workspaceId, (q) =>
    q.query<Pull>(`select ${PULL_FIELDS} from pulls where id = $1 and workspace_id = $2`, [pullId, workspaceId]),
  );
  const pull = res.rows[0];
  if (!pull) throw new ToolError(`No pull ${pullId} in this workspace.`);
  return pull;
}

/**
 * Works through the chunks of every running pull. State lives in the database, so a restarted
 * server carries on where it stopped, and a chunk whose worker died is picked up again once its
 * lock runs out.
 */
export class PullRunner {
  private readonly events = new EventEmitter();
  private readonly running = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: PullDeps) {
    this.events.setMaxListeners(0);
  }

  start(intervalMs = 1000): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick(): void {
    setImmediate(() => void this.tick());
  }

  /** Waits until the pull stops running, or until the time is up. */
  async wait(workspaceId: string, pullId: number, ms: number): Promise<Pull> {
    const deadline = Date.now() + ms;
    for (;;) {
      const pull = await getPull(this.deps.db, workspaceId, pullId);
      const left = deadline - Date.now();
      if (pull.status !== 'running' || left <= 0) return pull;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.events.off(`pull:${pullId}`, done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(left, 500));
        this.events.once(`pull:${pullId}`, done);
      });
    }
  }

  async cancel(workspaceId: string, pullId: number): Promise<Pull> {
    const { db } = this.deps;
    await getPull(db, workspaceId, pullId);
    await db.query("update pull_chunks set status = 'cancelled', updated_at = now() where pull_id = $1 and status = 'pending'", [pullId]);
    await db.query('update pulls set cancel_requested = true, updated_at = now() where id = $1', [pullId]);
    await this.settle(pullId);
    return getPull(db, workspaceId, pullId);
  }

  /** Carries on with a pull that paused because the account ran out of credits. */
  async resume(workspaceId: string, pullId: number): Promise<Pull> {
    const { db } = this.deps;
    await getPull(db, workspaceId, pullId);
    await db.query("update pulls set status = 'running', note = null, updated_at = now() where id = $1 and status = 'paused'", [pullId]);
    this.kick();
    return getPull(db, workspaceId, pullId);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      const { db, cfg } = this.deps;
      const ready = await db.query<{ id: number; workspace_id: string }>(
        `select c.id, c.workspace_id
           from pull_chunks c join pulls p on p.id = c.pull_id
          where p.status = 'running'
            and ((c.status = 'pending' and (c.not_before is null or c.not_before <= now()))
              or (c.status = 'running' and c.locked_until < now()))
          order by c.id
          limit 200`,
      );
      for (const candidate of ready.rows) {
        if ((this.running.get(candidate.workspace_id) ?? 0) >= cfg.chunksPerWorkspace) continue;
        const claimed = await db.query<Chunk>(
          `update pull_chunks
              set status = 'running', tries = tries + 1, locked_until = now() + interval '${LOCK_MINUTES} minutes', updated_at = now()
            where id = $1 and (status = 'pending' or (status = 'running' and locked_until < now()))
            returning id, pull_id, workspace_id, work, size, tries`,
          [candidate.id],
        );
        const chunk = claimed.rows[0];
        if (!chunk) continue;
        this.running.set(chunk.workspace_id, (this.running.get(chunk.workspace_id) ?? 0) + 1);
        void this.work(chunk).finally(() => {
          const left = (this.running.get(chunk.workspace_id) ?? 1) - 1;
          if (left <= 0) this.running.delete(chunk.workspace_id);
          else this.running.set(chunk.workspace_id, left);
          this.kick();
        });
      }
    } catch (err) {
      console.error('[pulls] runner tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  private async work(chunk: Chunk): Promise<void> {
    const { db, cfg } = this.deps;
    try {
      const handled = await this.runChunk(chunk);
      await db.query("update pull_chunks set status = 'done', error = null, updated_at = now() where id = $1", [chunk.id]);
      await db.query('update pulls set done = done + $1, updated_at = now() where id = $2', [handled, chunk.pull_id]);
    } catch (err) {
      if (err instanceof OutOfCredits) {
        // Not the chunk's fault. It goes back in line and the try is not counted.
        await db.query("update pull_chunks set status = 'pending', tries = greatest(tries - 1, 0), updated_at = now() where id = $1", [chunk.id]);
        await db.query(
          "update pulls set status = 'paused', note = 'CreatorDB reports that the account is out of credits.', updated_at = now() where id = $1 and status = 'running'",
          [chunk.pull_id],
        );
      } else {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        if (chunk.tries >= cfg.maxTries) {
          await db.query("update pull_chunks set status = 'failed', error = $2, updated_at = now() where id = $1", [chunk.id, message]);
          await db.query('update pulls set failed = failed + $1, updated_at = now() where id = $2', [chunk.size, chunk.pull_id]);
        } else {
          const delayMs = cfg.backoffBaseMs * 2 ** (chunk.tries - 1);
          await db.query(
            "update pull_chunks set status = 'pending', error = $2, not_before = now() + ($3::int * interval '1 millisecond'), updated_at = now() where id = $1",
            [chunk.id, message, delayMs],
          );
          setTimeout(() => this.kick(), delayMs + 5).unref?.();
        }
      }
    }
    await this.settle(chunk.pull_id);
  }

  /** Closes a pull once none of its chunks is waiting or running. */
  private async settle(pullId: number): Promise<void> {
    const { db } = this.deps;
    const counts = await db.query<{ open: number; failed: number }>(
      `select count(*) filter (where status in ('pending', 'running')) as open,
              count(*) filter (where status = 'failed') as failed
         from pull_chunks where pull_id = $1`,
      [pullId],
    );
    const { open, failed } = counts.rows[0]!;
    if (Number(open) === 0) {
      await db.query(
        `update pulls
            set status = case when cancel_requested then 'cancelled' when $2 > 0 then 'partial' else 'done' end,
                finished_at = now(), updated_at = now()
          where id = $1 and status = 'running'`,
        [pullId, Number(failed)],
      );
    }
    this.events.emit(`pull:${pullId}`);
  }

  /** Does one chunk's work and returns how many creators it handled. */
  private async runChunk(chunk: Chunk): Promise<number> {
    const { db, cfg } = this.deps;
    const found = await db.query<Pull>(`select ${PULL_FIELDS} from pulls where id = $1`, [chunk.pull_id]);
    const pull = found.rows[0]!;
    const workspaceId = pull.workspace_id;
    const apiKey = await workspaceKey(db, cfg, workspaceId);
    const tools = await officialHandlers();
    const request = pull.request;
    const newContext = (): CallContext => ({ workspaceId, apiKey, priority: 'pull', pullId: pull.id, capture: [] });

    let keys: string[];
    if (chunk.work.type === 'search') {
      const work = chunk.work;
      const search = request.search!;
      const ctx = newContext();
      const result = await callContext.run(ctx, () =>
        callOfficial(tools.get(search.tool)!, { ...search.args, pageSize: work.pageSize, offset: work.offset }),
      );
      if (ctx.outOfCredits) throw new OutOfCredits();
      const main = mainReply(ctx.capture);
      if (result.isError || !main) throw new Error(firstText(result));
      const { rows, meta } = main.extracted;
      const keyed = rows.map((data) => ({ key: rowKey(data), data }));
      // A retried page must not add its rows twice.
      const have = await existingKeys(db, workspaceId, pull.dataset_id, keyed.map((r) => r.key).filter((k): k is string => k !== null));
      await appendRows(db, workspaceId, pull.dataset_id, keyed.filter((r) => r.key === null || !have.has(r.key)));

      if (work.first) {
        const cap = Math.min(search.max_results ?? cfg.maxSearchResults, cfg.maxSearchResults);
        const matches = typeof meta.totalResults === 'number' ? meta.totalResults : rows.length;
        const total = Math.max(rows.length, Math.min(matches - work.offset, cap));
        const more: ChunkWork[] = [];
        if (rows.length === work.pageSize) {
          for (let offset = work.offset + work.pageSize; offset < work.offset + total; offset += work.pageSize) {
            more.push({ type: 'search', offset, pageSize: work.pageSize, first: false });
          }
        }
        await insertChunks(db, pull, more);
        await db.query('update pulls set total = $1, updated_at = now() where id = $2', [more.length ? total : rows.length, pull.id]);
      }
      keys = keyed.map((r) => r.key).filter((k): k is string => k !== null);
      if (request.calls.length === 0) return rows.length;
    } else {
      keys = chunk.work.keys;
    }

    const patches = new Map<string, Row>();
    await mapLimit(keys, cfg.callsPerChunk, async (key) => {
      const patch: Row = {};
      for (const call of request.calls) {
        const tool = tools.get(call.tool)!;
        const ctx = newContext();
        const result = await callContext.run(ctx, () => callOfficial(tool, { ...(call.args ?? {}), ...idArgs(tool, key) }));
        if (ctx.outOfCredits) throw new OutOfCredits();
        const main = mainReply(ctx.capture);
        const envelope = main?.reply.envelope;
        if (result.isError || !main) {
          patch[`_error_${call.tool}`] = firstText(result);
        } else if (isEnvelope(envelope) && typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)) {
          Object.assign(patch, envelope.data);
        } else {
          patch[call.tool] = isEnvelope(envelope) ? envelope.data : envelope;
        }
      }
      patches.set(key, patch);
    });
    await mergeIntoRows(db, workspaceId, pull.dataset_id, [...patches].map(([key, data]) => ({ key, data })));
    return keys.length;
  }
}

export async function pullDataset(db: Db, pull: Pull): Promise<Dataset> {
  return db.asWorkspace(pull.workspace_id, (q) => getDataset(q, pull.workspace_id, pull.dataset_id));
}
