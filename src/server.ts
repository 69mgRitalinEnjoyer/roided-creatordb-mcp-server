import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { officialInstructions, registerOfficialTools } from './official/loader.js';
import { makeAround } from './official/replies.js';
import type { PullRunner } from './pulls/pulls.js';
import { registerWorkspaceTools, WORKSPACE_INSTRUCTIONS } from './tools/register.js';

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
  await registerOfficialTools(server, makeAround(deps, auth));
  registerWorkspaceTools(server, deps, auth.workspaceId);
  return server;
}
