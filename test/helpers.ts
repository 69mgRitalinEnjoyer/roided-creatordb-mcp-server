import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureWorkspace } from '../src/auth/workspaces.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/client.js';
import { migrate } from '../src/db/schema.js';
import { Gateway, installGateway } from '../src/gateway/gateway.js';
import { PullRunner } from '../src/pulls/pulls.js';
import { buildMcpServer } from '../src/server.js';
import { FakeCreatorDb } from './fake-creatordb.js';

export interface Session {
  client: Client;
  workspaceId: string;
  /**
   * Calls a tool. `structured` is the reply's structuredContent, which some apps show the model in
   * place of the text; `view` is the live table's data, which travels in _meta.
   */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; structured?: Record<string, unknown>; view?: Record<string, unknown>; parts: string[] }>;
}

export interface TestEnv {
  cfg: Config;
  db: Db;
  fake: FakeCreatorDb;
  runner: PullRunner;
  connect(apiKey?: string): Promise<Session>;
  close(): Promise<void>;
}

/** A whole server in memory: embedded Postgres, the gateway, a pull runner and a fake CreatorDB. */
export async function makeEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'creatordb-workspace-test-'));
  const cfg: Config = {
    ...loadConfig({ DATA_DIR: dataDir, TOKEN_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787' }),
    backoffBaseMs: 2,
    pullWaitMs: 30_000,
    ...overrides,
  };
  const db = await openDb(cfg, { memory: true });
  await migrate(db);
  const fake = new FakeCreatorDb();
  installGateway(() => new Gateway({ db, cfg, upstream: fake.fetch }));
  const runner = new PullRunner({ db, cfg });
  runner.start(50);

  return {
    cfg,
    db,
    fake,
    runner,
    async connect(apiKey = 'key-a') {
      const workspaceId = await ensureWorkspace(db, cfg, apiKey);
      const server = await buildMcpServer({ db, cfg, runner }, { workspaceId, apiKey });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0' });
      await server.connect(serverSide);
      await client.connect(clientSide);
      return {
        client,
        workspaceId,
        async call(name, args = {}) {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
          const parts = (result.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '');
          const meta = result._meta as Record<string, unknown> | undefined;
          return {
            text: parts.join('\n'),
            parts,
            isError: result.isError === true,
            structured: result.structuredContent as Record<string, unknown> | undefined,
            view: meta?.['roided-mcp/view'] as Record<string, unknown> | undefined,
          };
        },
      };
    },
    async close() {
      runner.stop();
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The dataset ID named in a summary such as `saved   dataset 12, "name", 100 rows`. */
export function datasetIdIn(text: string): number {
  const match = /dataset (\d+)/.exec(text);
  if (!match) throw new Error(`no dataset ID in: ${text}`);
  return Number(match[1]);
}
