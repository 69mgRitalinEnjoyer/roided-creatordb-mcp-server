import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { officialInstructions, registerOfficialTools } from './official/loader.js';
import { makeAround } from './official/replies.js';
import type { PullRunner } from './pulls/pulls.js';
import { registerWorkspaceTools, WORKSPACE_INSTRUCTIONS } from './tools/register.js';
import { registerVetTool } from './tools/vet.js';

export const SERVER_NAME = 'roided-mcp';
export const SERVER_TITLE = 'Roided MCP';
export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  db: Db;
  cfg: Config;
  runner: PullRunner;
}

/**
 * Builds the MCP server for one signed-in workspace: the 48 official tools, routed through the
 * gateway, plus the workspace tools and the live table. A fresh one is built for every request,
 * as the official hosted server does.
 */
export async function buildMcpServer(deps: ServerDeps, auth: { workspaceId: string; apiKey: string }): Promise<McpServer> {
  const instructions = `${await officialInstructions()}\n\n${WORKSPACE_INSTRUCTIONS}`;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      websiteUrl: deps.cfg.publicUrl,
      icons: [
        { src: `${deps.cfg.publicUrl}/assets/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
        { src: `${deps.cfg.publicUrl}/assets/icon.png`, mimeType: 'image/png', sizes: ['192x192'] },
      ],
    },
    { instructions },
  );
  // vet_creators is the one official tool this server replaces: same inputs and the same reply for
  // up to 50 creators, but no limit on the list. See src/tools/vet.ts.
  const official = await registerOfficialTools(server, makeAround(deps, auth), { replace: ['vet_creators'] });
  registerWorkspaceTools(server, deps, auth.workspaceId);
  const vet = official.get('vet_creators');
  if (vet) registerVetTool(server, deps, auth, vet);
  return server;
}
