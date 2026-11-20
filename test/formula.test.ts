import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/workspace/datasets.js';
import { compileAggregate, compileFilter, compileFormula, compileToJson, Params } from '../src/workspace/formula.js';
import { cleanText, extractRows, flattenRow, rowKey } from '../src/workspace/rows.js';

describe('the formula language', () => {
  it('binds every name and value as a parameter', () => {
    const p = new Params();
    const sql = compileFilter('totalFollowers > 50000 and contains(bio, "skin\'care") or country in ("USA", "GBR")', p);
    // No name or value from the formula appears in the SQL text itself.
    for (const word of ['totalFollowers', 'bio', 'country', 'skin', 'USA', '50000']) expect(sql).not.toContain(word);
    expect(p.values).toEqual([['totalFollowers'], 50000, ['bio'], "skin'care", ['country'], 'USA', ['country'], 'GBR']);
  });

  it('reaches nested data with dots and odd names with backticks', () => {
    const p = new Params();
    compileFormula('reelsPerformanceRecent.views.median / `content-detail.recentReels`', p);
    expect(p.values).toEqual([['reelsPerformanceRecent', 'views', 'median'], ['content-detail', 'recentReels']]);
  });

  it('types its results', () => {
    expect(compileFormula('1 + 2 * 3', new Params()).type).toBe('num');
    expect(compileFormula('lower(bio)', new Params()).type).toBe('text');
    expect(compileFormula('followers > 10 and not contains(bio, "x")', new Params()).type).toBe('bool');
    expect(compileToJson('totalFollowers / 0', new Params())).toContain('nullif');
    expect(compileAggregate('median', 'totalFollowers', new Params())).toContain('percentile_cont');
  });

  it('rejects anything that is not a formula', () => {
    for (const bad of ['', '1 = 1; drop table datasets', 'select * from pulls', 'a ?? b', 'pg_sleep(10)', 'x = "unclosed', '((((1)', 'a b']) {
      expect(() => compileFilter(bad, new Params()), bad).toThrow(ToolError);
    }
    expect(() => compileAggregate('stddev', 'x', new Params())).toThrow(ToolError);
    // Two minus signs are plain arithmetic here, never the start of a SQL comment.
    expect(compileFormula('bio -- comment', new Params()).sql).not.toContain('--');
    expect(() => compileFormula('x'.repeat(2001), new Params())).toThrow(ToolError);
  });
});

describe('reading CreatorDB replies', () => {
  it('finds the list in a search reply and treats one creator as one row', () => {
    const search = extractRows({ creatorList: [{ uniqueId: 'a' }, { uniqueId: 'b' }], totalResults: 9, hasNextPage: true });
    expect(search).toMatchObject({ isList: true, meta: { totalResults: 9, hasNextPage: true } });
    expect(search.rows).toHaveLength(2);
    expect(extractRows({ creatorList: [], totalResults: 0 })).toMatchObject({ isList: true, rows: [] });
    const profile = extractRows({ uniqueId: 'a', emails: [], related: [{ uniqueId: 'b' }], stats: { n: 1 } });
    expect(profile).toMatchObject({ isList: false });
    expect(profile.rows).toHaveLength(1);
    expect(extractRows([{ text: 'hi' }, { text: 'there' }]).rows).toHaveLength(2);
  });

  it('flattens nested data and picks the right key', () => {
    expect(flattenRow({ a: { b: { c: 1 } }, tags: ['x', 'y'], list: [{ n: 1 }], none: null })).toEqual({
      'a.b.c': 1,
      tags: 'x; y',
      list: '[{"n":1}]',
      none: null,
    });
    expect(rowKey({ uniqueId: 'handle', channelId: 'UCabc' })).toBe('UCabc');
    expect(rowKey({ uniqueId: 'handle' })).toBe('handle');
    expect(rowKey({ name: 'x' })).toBeNull();
  });

  it('strips characters that are invisible to people but not to a model', () => {
    const ch = String.fromCharCode;
    const hidden = `Great${ch(0x200b)} bio${ch(0x202e, 0x2066)} here${ch(0xfeff)}${String.fromCodePoint(0xe0041, 0xe0042)}`;
    expect(cleanText(hidden)).toBe('Great bio here');
    expect(cleanText('Normal bio with emoji 🌿 and accents é')).toBe('Normal bio with emoji 🌿 and accents é');
  });
});
