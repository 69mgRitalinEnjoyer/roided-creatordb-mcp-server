import type { Config } from '../config.js';
import { callContext, isEnvelope, type CallContext, type CapturedReply } from '../context.js';
import type { Db } from '../db/client.js';
import { appendRows, createDataset, dailyDataset } from '../workspace/datasets.js';
import { writeDatasetFile } from '../workspace/files.js';
import { extractRows, type Extracted, type Row } from '../workspace/rows.js';
import { buildSummary, fmt } from '../workspace/summary.js';
import type { Around, ToolResult } from './loader.js';

export interface ReplyDeps {
  db: Db;
  cfg: Config;
}

/**
 * Replies the model has to read in full, however many rows they have: niche and topic lists give
 * the IDs for its next search, usage is a short account report, and a subtitle download is a
 * transcript, one row per line.
 */
const ALWAYS_IN_FULL = /^(list_[a-z]+_(niches|topics)|get_api_usage|get_youtube_subtitles_download)$/;

/** The reply that carries the tool's data: the last one CreatorDB answered successfully. */
export function mainReply(capture: CapturedReply[]): { reply: CapturedReply; extracted: Extracted } | null {
  for (let i = capture.length - 1; i >= 0; i--) {
    const reply = capture[i]!;
    if (reply.status >= 400 || reply.envelope === null) continue;
    if (Array.isArray(reply.envelope)) return { reply, extracted: extractRows(reply.envelope) };
    if (isEnvelope(reply.envelope) && reply.envelope.success !== false) {
      return { reply, extracted: extractRows(reply.envelope.data) };
    }
  }
  return null;
}

/**
 * Every row a tool call fetched. Most tools make one request. A few make several of the same
 * kind, as vet_creators does for a long list, and those add up to one result. Requests to other
 * endpoints, such as a niche lookup made before a search, are left out.
 */
function allRows(capture: CapturedReply[], main: { reply: CapturedReply; extracted: Extracted }): Row[] {
  if (!main.extracted.isList) return main.extracted.rows;
  const rows: Row[] = [];
  for (const reply of capture) {
    if (reply.path !== main.reply.path || reply.status >= 400 || !isEnvelope(reply.envelope) || reply.envelope.success === false) continue;
    const extracted = extractRows(reply.envelope.data);
    if (extracted.isList) rows.push(...extracted.rows);
  }
  return rows.length ? rows : main.extracted.rows;
}

/** A short name for a dataset, built from the call that produced it. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const bits: string[] = [];
  const filters = args.filters;
  if (Array.isArray(filters)) {
    for (const f of filters as Array<Record<string, unknown>>) {
      const value = Array.isArray(f.value) ? `${f.value.length} values` : String(f.value);
      bits.push(`${String(f.filterName)} ${String(f.op)} ${value}`);
    }
  } else {
    for (const [key, value] of Object.entries(args)) {
      if (key === 'fields' || value === undefined || typeof value === 'object') continue;
      bits.push(String(value));
    }
  }
  const text = bits.join(', ');
  return `${tool}${text ? `: ${text}` : ''}`.slice(0, 120);
}

/**
 * Wraps each official tool call for one signed-in workspace.
 *
 * The call runs with the workspace attached, so the gateway knows whose key to use. Afterwards:
 * a reply of up to `replyRowLimit` rows goes back exactly as the official code produced it, and
 * a longer one is kept in the workspace while the model gets a summary and a file link.
 */
export function makeAround(deps: ReplyDeps, auth: { workspaceId: string; apiKey: string }): Around {
  return async (tool, args, run) => {
    const ctx: CallContext = { workspaceId: auth.workspaceId, apiKey: auth.apiKey, priority: 'lookup', capture: [] };
    const result = await callContext.run(ctx, run);
    if (result.isError) return result;
    try {
      return await keepOrSwap(deps, auth.workspaceId, tool.name, args, result, ctx.capture);
    } catch (err) {
      // Saving is a bonus. If it fails, the model still gets the official reply.
      console.error(`[workspace] could not save the reply of ${tool.name}:`, err instanceof Error ? err.message : err);
      return result;
    }
  };
}

async function keepOrSwap(
  deps: ReplyDeps,
  workspaceId: string,
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
  capture: CapturedReply[],
): Promise<ToolResult> {
  if (ALWAYS_IN_FULL.test(tool)) return result;
  const main = mainReply(capture);
  if (!main || main.extracted.rows.length === 0) return result;
  const { meta } = main.extracted;
  const rows = allRows(capture, main);
  const credits = capture.reduce((sum, c) => sum + c.creditsUsed, 0);
  const { db, cfg } = deps;

  if (rows.length <= cfg.replyRowLimit) {
    const day = new Date().toISOString().slice(0, 10);
    await db.asWorkspace(workspaceId, async (q) => {
      const daily = await dailyDataset(q, workspaceId, day);
      await appendRows(q, workspaceId, daily.id, rows.map((data) => ({ data: { ...data, _tool: tool } })));
    });
    return result;
  }

  const dataset = await db.asWorkspace(workspaceId, async (q) => {
    const created = await createDataset(q, workspaceId, {
      name: describeCall(tool, args),
      kind: 'reply',
      source: { tool, args, meta },
    });
    await appendRows(q, workspaceId, created.id, rows.map((data) => ({ data })));
    return created;
  });
  const file = await writeDatasetFile(deps, workspaceId, dataset);
  const lines: Array<[string, string]> = [];
  if (typeof meta.totalResults === 'number' && meta.totalResults > rows.length) {
    lines.push(['matches', `${fmt(meta.totalResults)} in total, and this reply holds ${fmt(rows.length)}. pull_list with this search pulls every match.`]);
  }
  const text = await db.asWorkspace(workspaceId, (q) =>
    buildSummary(q, workspaceId, { dataset, rowCount: rows.length, credits, file, lines }),
  );
  return {
    content: [
      {
        type: 'text',
        text: `This reply had ${fmt(rows.length)} rows, more than the ${cfg.replyRowLimit} that are sent in full, so it was saved to the workspace.\n\n${text}`,
      },
    ],
  };
}
