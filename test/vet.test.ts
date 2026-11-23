import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleOf } from './fake-creatordb.js';
import { datasetIdIn, makeEnv, type Session, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: Session;

beforeAll(async () => {
  env = await makeEnv();
  env.fake.size = 1000;
  a = await env.connect('key-vet');
});
afterAll(() => env.close());

/** Creators number `from` to `to` on one platform, written as `prefix` + handle. */
const on = (platform: string, from: number, to: number, prefix = '') =>
  Array.from({ length: to - from + 1 }, (_, k) => ({ platform, handle: `${prefix}${handleOf(from + k)}` }));

/** Waits for a running pull to stop, and returns its last report. */
async function settle(report: string): Promise<string> {
  if (!/still running/.test(report)) return report;
  const pull = Number(/pull (\d+)/.exec(report)![1]);
  let text = report;
  for (let i = 0; i < 200 && /still running/.test(text); i++) {
    await new Promise((r) => setTimeout(r, 50));
    text = (await a.call('pull_status', { pull })).text;
  }
  return text;
}

describe('vet_creators', () => {
  it('takes any number of creators and can show the live table', async () => {
    const { tools } = await a.client.listTools();
    expect(tools).toHaveLength(62);
    const vet = tools.find((t) => t.name === 'vet_creators')!;
    const creators = (vet.inputSchema.properties as Record<string, { type?: string; maxItems?: number }>).creators!;
    expect(creators.type).toBe('array');
    expect(creators.maxItems).toBeUndefined();
    expect(vet.description).not.toContain('Up to 150');
    expect(vet.description).toContain('Any number of creators');
    expect(vet.annotations).toMatchObject({ title: 'Vet Creators in Bulk', readOnlyHint: true });
    expect((vet._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe('ui://creatordb-workspace/table');
  });

  it('answers a short list exactly as the official tool does', async () => {
    const out = await a.call('vet_creators', { creators: on('instagram', 1, 3) });
    expect(out.isError).toBe(false);
    expect(out.parts).toHaveLength(2);
    const body = JSON.parse(out.parts[0]!) as { creators: Array<Record<string, unknown>> };
    expect(body.creators.map((c) => c.handle).sort()).toEqual([handleOf(1), handleOf(2), handleOf(3)]);
    expect(body.creators.find((c) => c.handle === handleOf(2))).toMatchObject({ followers: 2000, engagementRate: '2%', medianViews: 600 });
    expect(out.parts[1]).toMatch(/^Credits used: 39 \| Remaining: \d+$/);
    // The person also gets the cards as a table. The model's text is untouched.
    expect(out.structured).toMatchObject({ table: { rows: 3 } });
  });

  it('checks 400 creators in one request, 100 per CreatorDB request, with no approval step', async () => {
    const searches = env.fake.count('/instagram/search');
    const out = await a.call('vet_creators', { creators: [...on('instagram', 1, 380), ...on('instagram', 5000, 5019)], name: 'Big vet' });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/pull\s+\d+, finished: 400 of 400 creators/);
    expect(out.text).toMatch(/results\s+380 vetted, 20 not found in CreatorDB/);
    expect(out.text).toContain('4,940 credits');
    expect(env.fake.count('/instagram/search') - searches).toBe(4);
    expect(out.structured).toMatchObject({ pull: { status: 'done', total: 400 }, table: { rows: 400 } });

    const dataset = datasetIdIn(out.text);
    const first = await a.call('query_dataset', { dataset, where: 'row = 1', columns: ['uniqueId', 'vet_status'] });
    expect(first.text).toContain(`1,${handleOf(1)},vetted`);
    // Percentages filter and sort as numbers.
    const hot = await a.call('query_dataset', { dataset, where: 'engagementRate > 5', limit: 0 });
    expect(hot.text).toContain('152 of 400 rows match');
    const best = await a.call('query_dataset', {
      dataset,
      columns: ['uniqueId', 'engagementRate'],
      sort: [{ by: 'engagementRate', desc: true }, { by: 'followers', desc: true }],
      limit: 1,
    });
    expect(best.text).toContain(`379,${handleOf(379)},9%`);
  });

  it('keeps one handle on two platforms apart, and skips YouTube handles search cannot match', async () => {
    const creators = [
      ...on('instagram', 1, 30),
      ...on('youtube', 101, 130, '@'),
      { platform: 'youtube', handle: '@크리에이터' },
      { platform: 'instagram', handle: `@${handleOf(1).toUpperCase()}` },
      { platform: 'youtube', handle: `https://www.youtube.com/@${handleOf(1)}` },
    ];
    const out = await settle((await a.call('vet_creators', { creators })).text);
    expect(out).toMatch(/finished: 62 of 62 creators/);
    expect(out).toMatch(/results\s+61 vetted, 1 skipped: YouTube search only takes handles/);

    const dataset = datasetIdIn(out);
    const pair = await a.call('query_dataset', {
      dataset,
      where: `contains(handle, "${handleOf(1)}")`,
      columns: ['uniqueId', 'platform', 'handle'],
      limit: 5,
    });
    expect(pair.text).toContain('2 of 62 rows match');
    expect(pair.text).toContain(`1,${handleOf(1)},instagram,${handleOf(1)}`);
    expect(pair.text).toContain(`62,@${handleOf(1)},youtube,@${handleOf(1)}`);
  });

  it('checks every creator in a saved dataset and adds the results to its rows', async () => {
    const imported = await a.call('import_list', { name: 'To vet', handles: Array.from({ length: 120 }, (_, k) => handleOf(k + 1)) });
    const dataset = datasetIdIn(imported.text);
    const unsure = await a.call('vet_creators', { dataset });
    expect(unsure.isError).toBe(true);
    expect(unsure.text).toContain('Pass platform');

    const out = await settle((await a.call('vet_creators', { dataset, platform: 'tiktok' })).text);
    expect(out).toMatch(/finished: 120 of 120 creators/);
    expect(datasetIdIn(out)).toBe(dataset);
    const row = await a.call('query_dataset', {
      dataset,
      where: 'row = 2',
      columns: ['uniqueId', 'platform', 'medianViews', 'sponsors', 'vet_status'],
    });
    expect(row.text).toContain(`2,${handleOf(2)},tiktok,600,not available on TikTok,vetted`);
  });

  it('pauses when credits run out, then carries on without paying twice', async () => {
    env.fake.paid.clear();
    env.fake.creditsAvailable = 13 * 100; // enough for 1 of the 2 requests
    const out = await a.call('vet_creators', { creators: on('instagram', 601, 800) });
    expect(out.text).toContain('is paused');
    const pull = Number(/pull (\d+)/.exec(out.text)![1]);

    env.fake.creditsAvailable = 1_000_000;
    const done = await settle((await a.call('pull_status', { pull, resume: true })).text);
    expect(done).toMatch(/finished: 200 of 200 creators/);
    expect(done).toMatch(/results\s+200 vetted/);
    const charges = [...env.fake.paid.entries()].filter(([key]) => key.startsWith('/instagram/search:'));
    expect(charges).toHaveLength(200);
    expect(Math.max(...charges.map(([, n]) => n))).toBe(1);
  });

  it('builds exactly the cards the official tool builds', async () => {
    const creators = [...on('instagram', 11, 20), ...on('youtube', 11, 20, '@'), ...on('tiktok', 11, 20)];
    // Up to 50 creators: the official tool's own code.
    const short = await a.call('vet_creators', { creators });
    const cards = (JSON.parse(short.parts[0]!) as { creators: Array<Record<string, unknown>> }).creators;
    expect(cards).toHaveLength(30);
    // The same creators in a longer list: this server's 100-per-request path.
    const long = await settle((await a.call('vet_creators', { creators: [...creators, ...on('instagram', 61, 90)] })).text);
    const rows = await env.db.query<{ data: Record<string, unknown> }>('select data from dataset_rows where dataset_id = $1', [datasetIdIn(long)]);
    for (const card of cards) {
      const row = rows.rows.find((r) => r.data.platform === card.platform && r.data.handle === card.handle);
      expect(row, `${String(card.platform)} ${String(card.handle)}`).toBeDefined();
      expect(Object.fromEntries(Object.keys(card).map((k) => [k, row!.data[k]]))).toEqual(card);
    }
  });

  it('explains a request it cannot run', async () => {
    const both = await a.call('vet_creators', { creators: on('instagram', 1, 2), dataset: 1 });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('not both');
    const neither = await a.call('vet_creators', {});
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('Give the creators to check');
  });
});
