import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GATEWAY_ORIGIN } from '../gateway/gateway.js';

/** What a tool hands back: the MCP SDK's own result type. */
export type ToolResult = CallToolResult;

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

export interface OfficialTool {
  name: string;
  description: string;
  /** The tool's inputs as the official code declared them: a map of zod types. */
  shape: Record<string, z.ZodType>;
  /** The official labels, such as readOnlyHint. */
  annotations?: Record<string, unknown>;
  handler: Handler;
}

/** Runs around every official tool call. It decides what the model gets back. */
export type Around = (tool: OfficialTool, args: Record<string, unknown>, run: () => Promise<ToolResult>) => Promise<ToolResult>;

interface OfficialModule {
  registerAllTools: (server: McpServer, apiKey: string) => void;
  SERVER_INSTRUCTIONS: string;
}

let officialModule: Promise<OfficialModule> | null = null;

/**
 * Loads the official package. Its API client reads `CREATORDB_API_BASE` once, when it is first
 * imported, so the setting has to point at the gateway before that import happens.
 */
export function loadOfficial(): Promise<OfficialModule> {
  if (!officialModule) {
    process.env.CREATORDB_API_BASE = GATEWAY_ORIGIN;
    officialModule = import('@creatordbai/mcp-server/register-tools') as Promise<OfficialModule>;
  }
  return officialModule;
}

/**
 * Registers the 48 official tools on a server, unchanged: same names, inputs, descriptions and
 * labels. Each handler is wrapped so `around` sees the call. The key passed to the official code
 * is a placeholder, because the gateway supplies the real one.
 */
export async function registerOfficialTools(
  server: McpServer,
  around: Around,
  options: { replace?: string[] } = {},
): Promise<Map<string, OfficialTool>> {
  const official = await loadOfficial();
  const tools = new Map<string, OfficialTool>();
  const target = server as unknown as { tool: (...args: unknown[]) => unknown };
  const realTool = target.tool.bind(server);

  // The official code calls server.tool(name, description, inputs, labels, handler).
  target.tool = (name: unknown, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as Handler;
    const shape = (rest.length >= 3 ? rest[1] : {}) as Record<string, z.ZodType>;
    const labels = rest.length >= 4 ? rest[2] : undefined;
    const tool: OfficialTool = {
      name: String(name),
      description: String(rest[0] ?? ''),
      shape: isShape(shape) ? shape : {},
      annotations: typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>) : undefined,
      handler,
    };
    tools.set(tool.name, tool);
    // A tool this server replaces with its own version stays in the map but is not registered.
    if (options.replace?.includes(tool.name)) return undefined;
    const wrapped: Handler = (args, extra) => around(tool, args, () => handler(args, extra));
    return realTool(name, ...rest.slice(0, -1), wrapped);
  };
  try {
    official.registerAllTools(server, 'supplied-by-the-gateway');
  } finally {
    // registerAllTools leaves its own wrapper on server.tool. Put the SDK's method back.
    target.tool = realTool;
  }
  return tools;
}

function isShape(value: Record<string, unknown>): boolean {
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((v) => typeof v === 'object' && v !== null && 'parse' in (v as object));
}

let handlerBank: Promise<Map<string, OfficialTool>> | null = null;

/**
 * The official handlers, for code that runs them outside a chat request. Whole-list pulls use
 * these, so a pull makes exactly the calls the official tool would make.
 */
export function officialHandlers(): Promise<Map<string, OfficialTool>> {
  if (!handlerBank) {
    const scratch = new McpServer({ name: 'official-handlers', version: '0' });
    handlerBank = registerOfficialTools(scratch, (_tool, _args, run) => run());
  }
  return handlerBank;
}

/** Runs an official tool the way the MCP server would: inputs are checked and tidied first. */
export async function callOfficial(tool: OfficialTool, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = z.object(tool.shape).safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { isError: true, content: [{ type: 'text', text: `Invalid input for ${tool.name}: ${issue?.path.join('.')} ${issue?.message}` }] };
  }
  return tool.handler(parsed.data as Record<string, unknown>);
}

export type VetCard = (platform: string, creator: Record<string, unknown>) => Record<string, unknown>;
let vetCardModule: Promise<VetCard> | null = null;

/**
 * The official vet_creators card builder. Long lists use it too, so every card is built the same
 * way whatever the list's length. The package doesn't list the file among its exports, so it is
 * loaded by its path; a test fails if an upgrade moves it.
 */
export function officialVetCard(): Promise<VetCard> {
  if (!vetCardModule) {
    vetCardModule = (async () => {
      await loadOfficial();
      const entry = createRequire(import.meta.url).resolve('@creatordbai/mcp-server/register-tools');
      const mod = (await import(pathToFileURL(join(dirname(entry), 'tools', 'vet.js')).href)) as { vetCard?: VetCard };
      if (typeof mod.vetCard !== 'function') throw new Error('The official package no longer has vetCard in tools/vet.js.');
      return mod.vetCard;
    })();
  }
  return vetCardModule;
}

export async function officialInstructions(): Promise<string> {
  return (await loadOfficial()).SERVER_INSTRUCTIONS;
}
