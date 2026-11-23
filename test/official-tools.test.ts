import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyFileLink } from '../src/workspace/files.js';
import { handleOf } from './fake-creatordb.js';
import { datasetIdIn, makeEnv, type Session, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: Session;

beforeAll(async () => {
  env = await makeEnv();
  a = await env.connect('key-a');
});
afterAll(() => env.close());

const NEW_TOOLS = [
  'import_list',
  'pull_list',
  'pull_status',
  'cancel_pull',
  'list_datasets',
  'describe_dataset',
  'query_dataset',
  'show_table',
  'add_column',
  'export_dataset',
  'delete_dataset',
  'next_batch',
  'submit_verdicts',
];

describe('the tool list', () => {
  it('has the 48 official tools, the 13 new ones and the table-only tool', async () => {
    const { tools } = await a.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of NEW_TOOLS) expect(names).toContain(name);
    const official = names.filter((n) => !NEW_TOOLS.includes(n) && n !== 'table_rows');
    expect(official).toHaveLength(48);
    for (const name of ['get_instagram_profile', 'search_youtube', 'vet_creators', 'get_api_usage', 'get_youtube_subtitles_download']) {
      expect(official).toContain(name);
    }
    expect(names).toHaveLength(62);
  });

  it('keeps the official labels and hides table_rows from the model', async () => {
    const { tools } = await a.client.listTools();
    const profile = tools.find((t) => t.name === 'get_instagram_profile')!;
    expect(profile.annotations?.readOnlyHint).toBe(true);
    expect(profile.inputSchema.properties).toHaveProperty('uniqueId');
    const rows = tools.find((t) => t.name === 'table_rows')!;
    expect((rows._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(['app']);
    const pull = tools.find((t) => t.name === 'pull_list')!;
    expect((pull._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe('ui://creatordb-workspace/table');
  });

  it('serves the live table as an MCP App resource', async () => {
    const res = await a.client.readResource({ uri: 'ui://creatordb-workspace/table' });
    const page = res.contents[0] as { mimeType: string; text: string };
    expect(page.mimeType).toBe('text/html;profile=mcp-app');
    expect(page.text).toContain('http://localhost:8787/assets/ext-apps.js');
    expect(page.text).toContain('table_rows');
  });
});

describe('an official call', () => {
  it('replies exactly as the official server does, and saves the raw reply', async () => {
    const before = env.fake.creditsAvailable;
    const out = await a.call('get_instagram_profile', { uniqueId: '@Creator_0007' });
    expect(out.isError).toBe(false);
    // The official reply is two text parts: the data as JSON, then the credit line.
    expect(JSON.parse(out.parts[0]!)).toMatchObject({ uniqueId: 'creator_0007', totalFollowers: 7000 });
    expect(out.parts[1]).toBe(`Credits used: 2 | Remaining: ${before - 2}`);

    const saved = await env.db.query<{ path: string; credits_used: number; workspace_id: string }>(
      'select path, credits_used, workspace_id from raw_replies order by id desc limit 1',
    );
    expect(saved.rows[0]).toMatchObject({ path: '/instagram/profile', credits_used: 2, workspace_id: a.workspaceId });
  });

  it('passes errors through untouched', async () => {
    const out = await a.call('get_instagram_profile', { uniqueId: 'nobody_here' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('NOT_FOUND');
  });

  it('retries when CreatorDB says to slow down', async () => {
    env.fake.slowDownNext = 2;
    const callsBefore = env.fake.count('/instagram/profile');
    const out = await a.call('get_instagram_profile', { uniqueId: handleOf(9) });
    expect(out.isError).toBe(false);
    expect(env.fake.count('/instagram/profile') - callsBefore).toBe(3);
  });
});

describe('the 50-row line', () => {
  it('always sends a transcript in full, however many lines it has', async () => {
    const out = await a.call('get_youtube_subtitles_download', { videoId: 'abc123', vssId: 'a.en' });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.parts[0]!)).toHaveLength(200);
    expect(out.parts[1]).toContain('200 entries');
  });

  it('sends a reply of up to 50 rows in full and files it under the day', async () => {
    const out = await a.call('search_instagram', { filters: [{ filterName: 'totalFollowers', op: '>', value: 0 }], pageSize: 20 });
    const data = JSON.parse(out.parts[0]!) as { creatorList: unknown[]; totalResults: number };
    expect(data.creatorList).toHaveLength(20);
    expect(data.totalResults).toBe(250);
    expect(out.parts.at(-1)).toMatch(/^Credits used: 1 \| Remaining: /);

    const list = await a.call('list_datasets');
    expect(list.text).toMatch(/Quick calls \d{4}-\d{2}-\d{2}/);
  });

  it('keeps a bigger reply in the workspace and sends a summary and a file link', async () => {
    const out = await a.call('search_instagram', { filters: [{ filterName: 'totalFollowers', op: '>', value: 0 }], pageSize: 100 });
    expect(out.isError).toBe(false);
    expect(out.parts).toHaveLength(1);
    expect(out.text).toContain('This reply had 100 rows');
    expect(out.text).toMatch(/saved\s+dataset \d+, "search_instagram: totalFollowers > 0", 100 rows/);
    expect(out.text).toMatch(/matches\s+250 in total/);
    expect(out.text).toContain('untrusted-data-');
    // Only the 5-row sample reaches the model, not the 100 rows.
    expect(out.text).toContain('creator_0250');
    expect(out.text).not.toContain('creator_0240');

    const url = new URL(/file\s+(http\S+)/.exec(out.text)![1]!);
    const fileId = url.pathname.split('/').pop()!;
    expect(verifyFileLink(env.cfg, fileId, url.searchParams.get('expires')!, url.searchParams.get('sig')!)).toBe(true);
    expect(verifyFileLink(env.cfg, fileId, url.searchParams.get('expires')!, 'tampered')).toBe(false);
    expect(verifyFileLink(env.cfg, fileId, '1', url.searchParams.get('sig')!)).toBe(false);
    const file = await env.db.query<{ path: string }>('select path from files where id = $1', [fileId]);
    expect(existsSync(file.rows[0]!.path)).toBe(true);
    const csv = readFileSync(file.rows[0]!.path, 'utf8').trim().split('\n');
    expect(csv).toHaveLength(101);
    expect(csv[0]).toContain('uniqueId');

    const id = datasetIdIn(out.text);
    const count = await a.call('query_dataset', { dataset: id, limit: 0 });
    expect(count.text).toContain('100 of 100 rows match');
  });
});
