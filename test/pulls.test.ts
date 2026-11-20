import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleOf } from './fake-creatordb.js';
import { datasetIdIn, makeEnv, type Session, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: Session;

beforeAll(async () => {
  env = await makeEnv();
  a = await env.connect('key-a');
});
afterAll(() => env.close());

const handles = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => handleOf(from + k));

describe('a whole-list pull over an imported list', () => {
  it('runs official calls on every creator in one request, with no approval step', async () => {
    const imported = await a.call('import_list', { name: 'Skincare shortlist', handles: [...handles(1, 250), handleOf(3), `@${handleOf(4)}`.replace('@', '')] });
    expect(imported.text).toMatch(/saved\s+dataset \d+, "Skincare shortlist", 250 rows/);
    const dataset = datasetIdIn(imported.text);

    const profileCalls = env.fake.count('/instagram/profile');
    const out = await a.call('pull_list', {
      dataset,
      calls: [{ tool: 'get_instagram_profile', args: { fields: ['displayName', 'totalFollowers', 'bio'] } }, { tool: 'get_instagram_contact' }],
    });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/pull\s+\d+, finished: 250 of 250 creators/);
    expect(out.text).toMatch(/saved\s+dataset \d+, "Skincare shortlist", 250 rows/);
    expect(out.text).toMatch(/file\s+http:\/\/localhost:8787\/files\//);
    // One CreatorDB request per creator per call, and nothing else.
    expect(env.fake.count('/instagram/profile') - profileCalls).toBe(250);
    expect(env.fake.count('/instagram/contact')).toBe(250);
    // The live table gets a pointer to the dataset, not the rows.
    expect(out.structured).toMatchObject({ pull: { status: 'done', done: 250, total: 250 }, table: { dataset, rows: 250 } });
    expect(JSON.stringify(out.structured)).not.toContain('example.com');

    const withEmail = await a.call('query_dataset', { dataset, where: 'emails is not null', limit: 0 });
    expect(withEmail.text).toContain('125 of 250 rows match');
    // Fractional profile calls cost 0.3 each, and a contact costs 15 only when an email is found.
    const pullId = Number(/pull\s+(\d+)/.exec(out.text)![1]);
    const pull = await env.db.query<{ credits: number }>('select credits from pulls where id = $1', [pullId]);
    expect(pull.rows[0]!.credits).toBeCloseTo(250 * 0.3 + 125 * 15, 5);
  });
});

describe('a whole-list pull over a search', () => {
  it('pages through every match and saves them as one dataset', async () => {
    const searchCalls = env.fake.count('/tiktok/search');
    const out = await a.call('pull_list', {
      search: { tool: 'search_tiktok', args: { filters: [{ filterName: 'totalFollowers', op: '>', value: 30000 }] } },
      name: 'TikTok over 30K',
    });
    expect(out.text).toMatch(/pull\s+\d+, finished: 220 of 220 creators/);
    expect(out.text).toMatch(/saved\s+dataset \d+, "TikTok over 30K", 220 rows/);
    expect(env.fake.count('/tiktok/search') - searchCalls).toBe(3);

    const dataset = datasetIdIn(out.text);
    const top = await a.call('query_dataset', { dataset, columns: ['uniqueId', 'totalFollowers'], sort: [{ by: 'totalFollowers', desc: true }], limit: 2 });
    expect(top.text).toContain('row,uniqueId,totalFollowers');
    expect(top.text).toContain('creator_0250,250000');
    expect(top.text).toContain('showing 1 to 2 of 220');

    const url = new URL(/file\s+(http\S+)/.exec(out.text)![1]!);
    const file = await env.db.query<{ path: string }>('select path from files where id = $1', [url.pathname.split('/').pop()]);
    expect(readFileSync(file.rows[0]!.path, 'utf8').trim().split('\n')).toHaveLength(221);
  });

  it('respects max_results and runs the named calls on each match', async () => {
    const out = await a.call('pull_list', {
      search: { tool: 'search_youtube', args: { filters: [{ filterName: 'totalSubscribers', op: '>', value: 0 }] }, max_results: 100 },
      calls: [{ tool: 'get_youtube_performance' }],
    });
    expect(out.text).toMatch(/finished: 100 of 100 creators/);
    expect(env.fake.count('/youtube/performance')).toBe(100);
    const dataset = datasetIdIn(out.text);
    const filled = await a.call('query_dataset', { dataset, where: 'reelsPerformanceRecent.views.median > 0', limit: 0 });
    expect(filled.text).toContain('100 of 100 rows match');
  });
});

describe('when the account runs out of credits', () => {
  it('pauses with everything saved, then carries on without paying twice', async () => {
    const imported = await a.call('import_list', { name: 'Budget test', handles: handles(1, 120) });
    const dataset = datasetIdIn(imported.text);
    env.fake.paid.clear();
    env.fake.creditsAvailable = 2 * 60; // enough for 60 of the 120 performance calls

    const out = await a.call('pull_list', { dataset, calls: [{ tool: 'get_instagram_performance' }] });
    expect(out.text).toContain('is paused');
    expect(out.text).toContain('out of credits');
    const pullId = Number(/pull (\d+)/.exec(out.text)![1]);

    env.fake.creditsAvailable = 1_000_000;
    let status = await a.call('pull_status', { pull: pullId, resume: true });
    for (let i = 0; i < 100 && /still running/.test(status.text); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await a.call('pull_status', { pull: pullId });
    }
    expect(status.text).toMatch(/finished: 120 of 120 creators/);
    const filled = await a.call('query_dataset', { dataset, where: 'reelsPerformanceRecent.views.median > 0', limit: 0 });
    expect(filled.text).toContain('120 of 120 rows match');
    // Every creator's performance was charged exactly once across the pause and the resume.
    const charges = [...env.fake.paid.entries()].filter(([key]) => key.startsWith('/instagram/performance'));
    expect(charges).toHaveLength(120);
    expect(Math.max(...charges.map(([, n]) => n))).toBe(1);
  });
});

describe('a pull that outlasts its call', () => {
  it('reports progress, keeps running, and can be cancelled', async () => {
    const slow = await makeEnv({ pullWaitMs: 150 });
    try {
      const s = await slow.connect('key-slow');
      slow.fake.delayMs = 20;
      slow.fake.size = 600;
      const imported = await s.call('import_list', { name: 'Slow list', handles: handles(1, 600) });
      const dataset = datasetIdIn(imported.text);
      const out = await s.call('pull_list', { dataset, calls: [{ tool: 'get_instagram_profile' }] });
      expect(out.text).toContain('is still running');
      expect(out.structured).toMatchObject({ pull: { status: 'running', total: 600 } });
      const pullId = Number(/pull (\d+)/.exec(out.text)![1]);

      const cancelled = await s.call('cancel_pull', { pull: pullId });
      expect(cancelled.text).toMatch(/pull \d+ is (cancelled|stopping)/);
      let status = await s.call('pull_status', { pull: pullId });
      for (let i = 0; i < 100 && /still running/.test(status.text); i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = await s.call('pull_status', { pull: pullId });
      }
      expect(status.text).toContain('cancelled');
      // Three chunks of 100 were in progress. The other three never started.
      expect(slow.fake.count('/instagram/profile')).toBeLessThanOrEqual(300);
    } finally {
      await slow.close();
    }
  });
});

describe('bad requests', () => {
  it('explains what is wrong in plain words', async () => {
    const none = await a.call('pull_list', { calls: [{ tool: 'get_instagram_profile' }] });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('Give a dataset');
    const unknown = await a.call('pull_list', { dataset: 1, calls: [{ tool: 'get_everything' }] });
    expect(unknown.text).toContain('is not one of the official tools');
    const notLookup = await a.call('pull_list', { dataset: 1, calls: [{ tool: 'search_instagram' }] });
    expect(notLookup.text).toContain("doesn't look up one creator");
  });
});
