export type Row = Record<string, unknown>;

export interface Extracted {
  rows: Row[];
  /** True when the reply held a list, false when it described one thing. */
  isList: boolean;
  /** The reply's other top-level values, such as `totalResults`. */
  meta: Row;
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds the rows in a CreatorDB reply. A reply is either a list, an object holding one list
 * (`creatorList`, `contentList` and so on), or a single object that counts as one row.
 */
export function extractRows(data: unknown): Extracted {
  if (Array.isArray(data)) {
    return { rows: data.map((item) => (isPlainObject(item) ? item : { value: item })), isList: true, meta: {} };
  }
  if (!isPlainObject(data)) return { rows: [], isList: false, meta: {} };

  let listKey: string | null = null;
  let longest = -1;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > longest && value.every(isPlainObject)) {
      listKey = key;
      longest = value.length;
    }
  }
  // An object with one list of objects and otherwise only simple values is a list reply. An
  // empty list only counts when its name says it is one, so `{ emails: [] }` stays a single row.
  const others = Object.entries(data).filter(([key]) => key !== listKey);
  const simpleOthers = others.every(([, v]) => v === null || typeof v !== 'object');
  const namedList = listKey !== null && /List$|^(results|records|items|histories)$/.test(listKey);
  if (listKey !== null && simpleOthers && (longest > 0 || namedList)) {
    return { rows: data[listKey] as Row[], isList: true, meta: Object.fromEntries(others) };
  }
  return { rows: [data], isList: false, meta: {} };
}

/** The value that identifies a creator, video or brand in a row. */
export function rowKey(row: Row): string | null {
  for (const field of ['channelId', 'uniqueId', 'brandId', 'contentId', 'videoId', 'id']) {
    const value = row[field];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * Characters that are invisible on screen but still reach a language model: zero-width marks,
 * text-direction controls and the Unicode "tag" block. Creator bios can carry instructions in them.
 */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

export function cleanText(value: string): string {
  return value.replace(HIDDEN_CHARS, '');
}

export type Cell = string | number | boolean | null;

/** Turns nested data into flat columns named with dots, for example `performance.views.median`. */
export function flattenRow(row: Row, prefix = '', out: Record<string, Cell> = {}): Record<string, Cell> {
  for (const [key, value] of Object.entries(row)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      out[name] = null;
    } else if (isPlainObject(value)) {
      flattenRow(value, name, out);
    } else if (Array.isArray(value)) {
      const simple = value.every((v) => v === null || typeof v !== 'object');
      out[name] = simple ? value.join('; ') : JSON.stringify(value);
    } else if (typeof value === 'string') {
      out[name] = cleanText(value);
    } else {
      out[name] = value as number | boolean;
    }
  }
  return out;
}

function csvCell(value: Cell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

/** Shortens long text for the few rows a model reads directly. Files keep the full text. */
export function clip(value: Cell, max: number): Cell {
  if (typeof value !== 'string') return value;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
