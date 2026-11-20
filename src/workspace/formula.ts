import { ToolError } from './datasets.js';

/**
 * A small formula language for filters, sort keys and computed columns.
 *
 * The model never writes SQL. It writes formulas such as
 *   totalFollowers > 50000 and contains(bio, "skincare")
 *   round(reelsPerformanceRecent.views.median / totalFollowers, 3)
 * and this file turns them into SQL in which every name and every value is a bound parameter.
 */

type ValueType = 'num' | 'text' | 'bool' | 'any';

export interface Compiled {
  sql: string;
  type: ValueType;
}

/** Collects bound parameters, so compiled fragments can share one statement. */
export class Params {
  readonly values: unknown[];
  constructor(initial: unknown[] = []) {
    this.values = [...initial];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string[] }
  | { t: 'op'; v: string }
  | { t: 'end' };

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'null', 'true', 'false']);
const MAX_LENGTH = 2000;
const MAX_DEPTH = 40;

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH) throw new ToolError(`A formula can be at most ${MAX_LENGTH} characters long.`);
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j];
        j++;
      }
      if (j >= src.length) throw new ToolError('A text value in the formula is missing its closing quote.');
      tokens.push({ t: 'str', v: text });
      i = j + 1;
    } else if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end === -1) throw new ToolError('A column name in backticks is missing its closing backtick.');
      tokens.push({ t: 'id', v: src.slice(i + 1, end).split('.') });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*/.exec(src.slice(i))!;
      const lower = m[0].toLowerCase();
      tokens.push(KEYWORDS.has(lower) ? { t: 'op', v: lower } : { t: 'id', v: m[0].split('.') });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '!=', '<>', '=='].includes(two)) {
        tokens.push({ t: 'op', v: two === '==' ? '=' : two === '<>' ? '!=' : two });
        i += 2;
      } else if ('+-*/%()=<>,'.includes(ch)) {
        tokens.push({ t: 'op', v: ch });
        i++;
      } else {
        throw new ToolError(`The formula has a character it can't use: "${ch}".`);
      }
    }
  }
  tokens.push({ t: 'end' });
  return tokens;
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'col'; path: string[] }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'unary'; op: '-' | 'not'; arg: Node }
  | { k: 'binary'; op: string; left: Node; right: Node }
  | { k: 'in'; left: Node; items: Node[] }
  | { k: 'isnull'; arg: Node; negate: boolean };

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    if (this.peek().t !== 'end') throw new ToolError('The formula has extra text after its end. Check for a missing "and" or "or".');
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private isOp(v: string): boolean {
    const tok = this.peek();
    return tok.t === 'op' && tok.v === v;
  }
  private take(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.pos++;
    return true;
  }
  private expect(v: string): void {
    if (!this.take(v)) throw new ToolError(`The formula is missing "${v}".`);
  }
  private nest<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ToolError('The formula is nested too deeply.');
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private or(): Node {
    let left = this.and();
    while (this.take('or')) left = { k: 'binary', op: 'or', left, right: this.and() };
    return left;
  }
  private and(): Node {
    let left = this.not();
    while (this.take('and')) left = { k: 'binary', op: 'and', left, right: this.not() };
    return left;
  }
  private not(): Node {
    if (this.take('not')) return this.nest(() => ({ k: 'unary', op: 'not', arg: this.not() }));
    return this.comparison();
  }
  private comparison(): Node {
    const left = this.sum();
    for (const op of ['=', '!=', '<=', '>=', '<', '>']) {
      if (this.take(op)) return { k: 'binary', op, left, right: this.sum() };
    }
    if (this.take('in')) {
      this.expect('(');
      const items = [this.or()];
      while (this.take(',')) items.push(this.or());
      this.expect(')');
      return { k: 'in', left, items };
    }
    if (this.take('is')) {
      const negate = this.take('not');
      this.expect('null');
      return { k: 'isnull', arg: left, negate };
    }
    return left;
  }
  private sum(): Node {
    let left = this.product();
    for (;;) {
      if (this.take('+')) left = { k: 'binary', op: '+', left, right: this.product() };
      else if (this.take('-')) left = { k: 'binary', op: '-', left, right: this.product() };
      else return left;
    }
  }
  private product(): Node {
    let left = this.unary();
    for (;;) {
      if (this.take('*')) left = { k: 'binary', op: '*', left, right: this.unary() };
      else if (this.take('/')) left = { k: 'binary', op: '/', left, right: this.unary() };
      else if (this.take('%')) left = { k: 'binary', op: '%', left, right: this.unary() };
      else return left;
    }
  }
  private unary(): Node {
    if (this.take('-')) return this.nest(() => ({ k: 'unary', op: '-', arg: this.unary() }));
    return this.primary();
  }
  private primary(): Node {
    const tok = this.peek();
    if (tok.t === 'num') {
      this.pos++;
      return { k: 'num', v: tok.v };
    }
    if (tok.t === 'str') {
      this.pos++;
      return { k: 'str', v: tok.v };
    }
    if (tok.t === 'op' && (tok.v === 'true' || tok.v === 'false')) {
      this.pos++;
      return { k: 'bool', v: tok.v === 'true' };
    }
    if (tok.t === 'op' && tok.v === 'null') {
      this.pos++;
      return { k: 'null' };
    }
    if (tok.t === 'id') {
      this.pos++;
      if (tok.v.length === 1 && this.take('(')) {
        const args: Node[] = [];
        if (!this.take(')')) {
          args.push(this.nest(() => this.or()));
          while (this.take(',')) args.push(this.nest(() => this.or()));
          this.expect(')');
        }
        return { k: 'call', name: tok.v[0]!.toLowerCase(), args };
      }
      return { k: 'col', path: tok.v };
    }
    if (this.take('(')) {
      const inner = this.nest(() => this.or());
      this.expect(')');
      return inner;
    }
    throw new ToolError('The formula ends too early or has a symbol in the wrong place.');
  }
}

/** Names that stand for the same thing on every platform. */
const ALIASES: Record<string, (p: Params) => Compiled> = {
  row: () => ({ sql: 'r.row_no', type: 'num' }),
  key: () => ({ sql: 'r.key', type: 'text' }),
  handle: (p) => ({ sql: `coalesce(r.data #>> ${p.add(['uniqueId'])}::text[], r.data #>> ${p.add(['handle'])}::text[], r.key)`, type: 'text' }),
  followers: (p) => ({
    sql:
      `safe_num(coalesce(r.data #>> ${p.add(['totalFollowers'])}::text[], r.data #>> ${p.add(['totalSubscribers'])}::text[], ` +
      `r.data #>> ${p.add(['followers'])}::text[]))`,
    type: 'num',
  }),
};

function column(path: string[], p: Params): Compiled {
  if (path.length === 1) {
    const alias = ALIASES[path[0]!];
    if (alias) return alias(p);
  }
  for (const part of path) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(part)) throw new ToolError(`"${path.join('.')}" is not a usable column name.`);
  }
  const ref = p.add(path);
  // Columns the model added sit in `extra` and win over fetched data with the same name.
  return { sql: `coalesce(r.extra #>> ${ref}::text[], r.data #>> ${ref}::text[])`, type: 'any' };
}

function asNum(c: Compiled): string {
  if (c.type === 'num') return c.sql;
  if (c.type === 'bool') return `(case when ${c.sql} then 1 else 0 end)`;
  return `safe_num(${c.sql})`;
}
function asText(c: Compiled): string {
  return c.type === 'text' || c.type === 'any' ? c.sql : `(${c.sql})::text`;
}
function asBool(c: Compiled): string {
  if (c.type === 'bool') return c.sql;
  if (c.type === 'num') return `(${c.sql} <> 0)`;
  return `(lower(${c.sql}) in ('true', 't', 'yes', '1'))`;
}

const NUM_FUNCS: Record<string, (args: string[]) => string> = {
  abs: ([a]) => `abs(${a})`,
  floor: ([a]) => `floor(${a})`,
  ceil: ([a]) => `ceil(${a})`,
  sqrt: ([a]) => `sqrt(greatest(${a}, 0))`,
  ln: ([a]) => `ln(nullif(greatest(${a}, 0), 0))`,
  log10: ([a]) => `log(nullif(greatest(${a}, 0), 0))`,
};

function compileNode(node: Node, p: Params): Compiled {
  switch (node.k) {
    case 'num':
      return { sql: `${p.add(node.v)}::numeric`, type: 'num' };
    case 'str':
      return { sql: `${p.add(node.v)}::text`, type: 'text' };
    case 'bool':
      return { sql: node.v ? 'true' : 'false', type: 'bool' };
    case 'null':
      return { sql: 'null', type: 'any' };
    case 'col':
      return column(node.path, p);
    case 'unary': {
      const arg = compileNode(node.arg, p);
      return node.op === '-' ? { sql: `(-${asNum(arg)})`, type: 'num' } : { sql: `(not coalesce(${asBool(arg)}, false))`, type: 'bool' };
    }
    case 'isnull': {
      const arg = compileNode(node.arg, p);
      // An empty list or object counts as empty too, so `emails is not null` means "has an email".
      const empty =
        arg.type === 'num' || arg.type === 'bool' ? `${arg.sql} is null` : `(${arg.sql} is null or ${arg.sql} in ('', '[]', '{}'))`;
      return { sql: node.negate ? `(not ${empty})` : `(${empty})`, type: 'bool' };
    }
    case 'in': {
      const tests = node.items.map((item) => compare('=', node.left, item, p).sql);
      return { sql: `(${tests.join(' or ')})`, type: 'bool' };
    }
    case 'binary': {
      if (node.op === 'and' || node.op === 'or') {
        const l = compileNode(node.left, p);
        const r = compileNode(node.right, p);
        return { sql: `(coalesce(${asBool(l)}, false) ${node.op} coalesce(${asBool(r)}, false))`, type: 'bool' };
      }
      if (['=', '!=', '<', '<=', '>', '>='].includes(node.op)) return compare(node.op, node.left, node.right, p);
      const l = asNum(compileNode(node.left, p));
      const r = asNum(compileNode(node.right, p));
      if (node.op === '/') return { sql: `(${l} / nullif(${r}, 0))`, type: 'num' };
      if (node.op === '%') return { sql: `mod(${l}, nullif(${r}, 0))`, type: 'num' };
      return { sql: `(${l} ${node.op} ${r})`, type: 'num' };
    }
    case 'call':
      return call(node.name, node.args, p);
  }
}

function compare(op: string, left: Node, right: Node, p: Params): Compiled {
  const l = compileNode(left, p);
  const r = compileNode(right, p);
  const sqlOp = op === '!=' ? '<>' : op;
  if (l.type === 'num' || r.type === 'num') return { sql: `(${asNum(l)} ${sqlOp} ${asNum(r)})`, type: 'bool' };
  if (l.type === 'bool' || r.type === 'bool') return { sql: `(${asBool(l)} ${sqlOp} ${asBool(r)})`, type: 'bool' };
  return { sql: `(${asText(l)} ${sqlOp} ${asText(r)})`, type: 'bool' };
}

function need(name: string, args: Node[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    const count = min === max ? `${min}` : `${min} to ${max}`;
    throw new ToolError(`${name}() takes ${count} value${max === 1 ? '' : 's'}.`);
  }
}

function call(name: string, args: Node[], p: Params): Compiled {
  const c = args.map((a) => compileNode(a, p));
  if (NUM_FUNCS[name]) {
    need(name, args, 1);
    return { sql: NUM_FUNCS[name]!([asNum(c[0]!)]), type: 'num' };
  }
  switch (name) {
    case 'round':
      need(name, args, 1, 2);
      return { sql: `round(${asNum(c[0]!)}, ${c[1] ? `(${asNum(c[1])})::int` : '0'})`, type: 'num' };
    case 'min':
    case 'max':
      need(name, args, 2, 8);
      return { sql: `${name === 'min' ? 'least' : 'greatest'}(${c.map(asNum).join(', ')})`, type: 'num' };
    case 'number':
      need(name, args, 1);
      return { sql: asNum(c[0]!), type: 'num' };
    case 'text':
      need(name, args, 1);
      return { sql: asText(c[0]!), type: 'text' };
    case 'lower':
    case 'upper':
      need(name, args, 1);
      return { sql: `${name}(${asText(c[0]!)})`, type: 'text' };
    case 'length':
      need(name, args, 1);
      return { sql: `length(${asText(c[0]!)})`, type: 'num' };
    case 'contains':
      need(name, args, 2);
      return { sql: `(position(lower(${asText(c[1]!)}) in lower(coalesce(${asText(c[0]!)}, ''))) > 0)`, type: 'bool' };
    case 'startswith':
      need(name, args, 2);
      return { sql: `(left(lower(coalesce(${asText(c[0]!)}, '')), length(${asText(c[1]!)})) = lower(${asText(c[1]!)}))`, type: 'bool' };
    case 'endswith':
      need(name, args, 2);
      return { sql: `(right(lower(coalesce(${asText(c[0]!)}, '')), length(${asText(c[1]!)})) = lower(${asText(c[1]!)}))`, type: 'bool' };
    case 'coalesce': {
      need(name, args, 2, 8);
      const numeric = c.some((x) => x.type === 'num');
      return numeric
        ? { sql: `coalesce(${c.map(asNum).join(', ')})`, type: 'num' }
        : { sql: `coalesce(${c.map((x) => `nullif(${asText(x)}, '')`).join(', ')})`, type: 'text' };
    }
    case 'if': {
      need(name, args, 3);
      const numeric = c[1]!.type === 'num' || c[2]!.type === 'num';
      const pick = numeric ? asNum : asText;
      return {
        sql: `(case when coalesce(${asBool(c[0]!)}, false) then ${pick(c[1]!)} else ${pick(c[2]!)} end)`,
        type: numeric ? 'num' : 'text',
      };
    }
    default:
      throw new ToolError(
        `"${name}" is not a formula function. The functions are: contains, startswith, endswith, lower, upper, length, ` +
          'round, abs, floor, ceil, sqrt, ln, log10, min, max, number, text, coalesce, if.',
      );
  }
}

/** Compiles a formula into SQL over the rows alias `r`. */
export function compileFormula(source: string, p: Params): Compiled {
  if (!source.trim()) throw new ToolError('The formula is empty.');
  return compileNode(new Parser(tokenize(source)).parse(), p);
}

/** A formula used as a yes-or-no test. */
export function compileFilter(source: string, p: Params): string {
  return `coalesce(${asBool(compileFormula(source, p))}, false)`;
}

/** A formula's result as a jsonb value, for storing a computed column. */
export function compileToJson(source: string, p: Params): string {
  const c = compileFormula(source, p);
  return `to_jsonb(${c.type === 'any' ? asText(c) : c.sql})`;
}

/** A sort key. Text that looks like a number sorts as a number. */
export function compileSortKey(source: string, p: Params): { num: string; text: string } {
  const c = compileFormula(source, p);
  if (c.type === 'num' || c.type === 'bool') return { num: asNum(c), text: 'null' };
  return { num: `safe_num(${c.sql})`, text: c.sql };
}

const AGGREGATES: Record<string, (x: string) => string> = {
  count: () => 'count(*)',
  sum: (x) => `sum(${x})`,
  avg: (x) => `avg(${x})`,
  min: (x) => `min(${x})`,
  max: (x) => `max(${x})`,
  median: (x) => `percentile_cont(0.5) within group (order by ${x})`,
};

export function compileAggregate(fn: string, of: string | undefined, p: Params): string {
  const make = AGGREGATES[fn.toLowerCase()];
  if (!make) throw new ToolError(`"${fn}" is not a measure. The measures are: count, sum, avg, min, max, median.`);
  if (fn.toLowerCase() === 'count') return make('');
  if (!of) throw new ToolError(`${fn} needs a column or formula to work on.`);
  return make(asNum(compileFormula(of, p)));
}
