import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { callContext, type CallContext } from '../context.js';
import { callOfficial, type OfficialTool, type ToolResult } from '../official/loader.js';
import { readVetCards, startVet } from '../pulls/pulls.js';
import { TABLE_URI } from '../ui/table.js';
import { appendRows, createDataset, getDataset, ToolError } from '../workspace/datasets.js';
import { defaultColumns } from '../workspace/query.js';
import { datasetRef, pullReport, safe, tableInfo, type ToolDeps } from './register.js';

const PLATFORM = z.enum(['youtube', 'instagram', 'tiktok']);

const UNLIMITED =
  'Any number of creators: up to 50 come back in this reply, and a longer list, or every creator in a saved `dataset`, ' +
  'is checked on the server and comes back as a summary with a live table and a CSV file. ' +
  'YouTube handles with letters outside a-z are skipped and marked, because YouTube search cannot match them.';

/** The official description, with its 150-creator limit replaced. */
export function vetDescription(official: string): string {
  const limit = 'Up to 150 creators per call.';
  return official.includes(limit) ? official.replace(limit, UNLIMITED) : `${official} ${UNLIMITED}`;
}

type Auth = { workspaceId: string; apiKey: string };

/**
 * The official vet_creators without its 150-creator limit.
 *
 * Up to 50 creators go through the official tool exactly as on the official server, so the
 * reply is the same. A longer list, or every creator in a saved dataset, runs as a background
 * pull: 300 creators per step, 100 per CreatorDB request (the official tool sends 50). It starts
 * at once and comes back as a summary with a live table and a CSV file.
 */
export function registerVetTool(server: McpServer, deps: ToolDeps, auth: Auth, official: OfficialTool): void {
  const { cfg, runner } = deps;
  const title = typeof official.annotations?.title === 'string' ? official.annotations.title : 'Vet creators';
  registerAppTool(
    server,
    'vet_creators',
    {
      title,
      description: vetDescription(official.description),
      inputSchema: {
        creators: z
          .array(
            z.object({
              platform: PLATFORM,
              handle: z.string().min(1).describe('Handle as returned by search. YouTube: the @handle, not the channel ID.'),
            }),
          )
          .min(1)
          .optional()
          .describe('Creators to check, on any mix of platforms. Any number.'),
        dataset: datasetRef.optional().describe('A saved dataset. Every creator in it is checked, and the results are added to its rows.'),
        platform: PLATFORM.optional().describe('With dataset: the platform of rows that do not say which platform they are on.'),
        name: z.string().max(120).optional().describe('A name for the dataset that a long list creates.'),
      },
      annotations: official.annotations as ToolAnnotations | undefined,
      _meta: { ui: { resourceUri: TABLE_URI } },
    },
    safe('vet_creators', async ({ creators, dataset, platform, name }) => {
      if (dataset !== undefined && creators?.length) throw new ToolError('Give either creators or a dataset, not both.');
      if (dataset === undefined) {
        if (!creators?.length) throw new ToolError('Give the creators to check, or a dataset to check every creator in.');
        if (creators.length <= cfg.replyRowLimit) return vetInReply(deps, auth, official, creators);
      }
      const pull = await startVet(deps, runner, auth.workspaceId, { creators, dataset, platform, name });
      const settled = await runner.wait(auth.workspaceId, pull.id, cfg.pullWaitMs);
      return pullReport(deps, auth.workspaceId, settled);
    }),
  );
}

/** A short list: the official tool's own reply, plus a pointer the live table uses to show the cards. */
async function vetInReply(deps: ToolDeps, auth: Auth, official: OfficialTool, creators: Array<{ platform: string; handle: string }>): Promise<ToolResult> {
  const ctx: CallContext = { workspaceId: auth.workspaceId, apiKey: auth.apiKey, priority: 'lookup', capture: [] };
  const result = await callContext.run(ctx, () => callOfficial(official, { creators }));
  const cards = readVetCards(result);
  if (result.isError || !cards?.length) return result;
  try {
    const table = await deps.db.asWorkspace(auth.workspaceId, async (q) => {
      const created = await createDataset(q, auth.workspaceId, {
        name: `vet_creators: ${cards.length} creators`,
        kind: 'vet',
        source: { tool: 'vet_creators', creators },
      });
      await appendRows(
        q,
        auth.workspaceId,
        created.id,
        cards.map((card) => ({ key: typeof card.handle === 'string' ? card.handle : null, data: { ...card, vet_status: 'vetted' } })),
      );
      const dataset = await getDataset(q, auth.workspaceId, created.id);
      return tableInfo(dataset, await defaultColumns(q, auth.workspaceId, dataset.id));
    });
    // The text the model reads is the official reply, unchanged. The table reads its rows from the workspace.
    return { ...result, structuredContent: { table } };
  } catch (err) {
    console.error('[vet] could not save the cards:', err instanceof Error ? err.message : err);
    return result;
  }
}
