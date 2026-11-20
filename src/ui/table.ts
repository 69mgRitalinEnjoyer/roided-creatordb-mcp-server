/** The address of the live table. MCP App resources use the ui:// scheme. */
export const TABLE_URI = 'ui://creatordb-workspace/table';

/**
 * The live table: a small page that Claude's app draws inside the chat.
 *
 * It never receives rows through the model. It asks this server for a page of rows with the
 * `table_rows` tool, which only the page itself can call, and draws them. While a whole-list pull
 * is still running it shows progress and checks again every few seconds.
 */
export function tableHtml(scriptUrl: string): string {
  return PAGE.replace('__SCRIPT_URL__', scriptUrl);
}

const PAGE = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>CreatorDB dataset</title>
<style>
  :root { --line: color-mix(in srgb, currentColor 16%, transparent); --soft: color-mix(in srgb, currentColor 6%, transparent); --muted: color-mix(in srgb, currentColor 62%, transparent); }
  body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 10px 12px 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  .title { font-weight: 600; font-size: 14px; margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  input[type=text] { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; flex: 1 1 240px; min-width: 0; }
  button { font: inherit; padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--soft); }
  button:disabled { color: var(--muted); cursor: default; }
  .wrap { overflow: auto; max-height: 460px; border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: Canvas; cursor: pointer; user-select: none; font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:hover td { background: var(--soft); }
  tbody tr:last-child td { border-bottom: 0; }
  .foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; color: var(--muted); }
  .grow { margin-right: auto; }
  .msg { padding: 14px 4px; color: var(--muted); }
  .err { color: #c0392b; margin: 6px 0; }
  progress { width: 240px; vertical-align: middle; }
</style></head>
<body>
<div id="root"><div class="msg">Loading…</div></div>
<script type="module">
import { App } from "__SCRIPT_URL__";

const PAGE_SIZE = 100;
const BT = String.fromCharCode(96);
const root = document.getElementById("root");
const app = new App({ name: "CreatorDB table", version: "0.1.0" });
const state = { table: null, pull: null, offset: 0, sort: [], where: "", typed: "", columns: [], rows: [], matched: 0, busy: false, error: "", note: "", shown: null };
let pollTimer = null;
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}

function textOf(result) {
  const item = (result && result.content || []).find((c) => c.type === "text");
  return item ? item.text : "";
}

async function load() {
  if (!state.table) return;
  state.busy = true; state.error = ""; render();
  try {
    const result = await app.callServerTool({ name: "table_rows", arguments: {
      dataset: state.table.dataset, offset: state.offset, limit: PAGE_SIZE,
      where: state.where || undefined, sort: state.sort.length ? state.sort : undefined } });
    if (result.isError || !result.structuredContent) throw new Error(textOf(result) || "The rows could not be loaded.");
    const sc = result.structuredContent;
    state.columns = sc.columns; state.rows = sc.rows; state.matched = sc.matched;
    state.shown = { offset: state.offset, where: state.where, sort: state.sort };
  } catch (err) {
    state.error = err && err.message ? err.message : String(err);
    // The rows on screen are still the last ones that loaded, so the footer has to describe those.
    if (state.shown) { state.offset = state.shown.offset; state.where = state.shown.where; state.sort = state.shown.sort; }
  }
  state.busy = false; render();
}

function sortBy(column) {
  const key = BT + column + BT;
  const current = state.sort[0];
  if (!current || current.by !== key) state.sort = [{ by: key, desc: true }];
  else if (current.desc) state.sort = [{ by: key, desc: false }];
  else state.sort = [];
  state.offset = 0; load();
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function download() {
  if (!state.table || state.busy) return;
  state.busy = true; state.note = "Preparing the file…"; render();
  try {
    const lines = []; let offset = 0; let columns = null;
    for (;;) {
      const result = await app.callServerTool({ name: "table_rows", arguments: {
        dataset: state.table.dataset, offset, limit: 1000, all_columns: true,
        where: state.where || undefined, sort: state.sort.length ? state.sort : undefined } });
      const sc = result.structuredContent;
      if (result.isError || !sc) throw new Error(textOf(result) || "The rows could not be loaded.");
      if (!columns) { columns = sc.columns; lines.push(columns.map(csvCell).join(",")); }
      for (const row of sc.rows) lines.push(row.map(csvCell).join(","));
      offset += sc.rows.length;
      state.note = "Preparing the file… " + nf.format(offset) + " of " + nf.format(sc.matched) + " rows"; render();
      if (sc.rows.length < 1000 || offset >= sc.matched) break;
    }
    const name = (state.table.name || "dataset").replace(/[^A-Za-z0-9 _-]+/g, " ").trim().slice(0, 60) || "dataset";
    const out = await app.downloadFile({ contents: [{ type: "resource", resource: {
      uri: "file:///" + name + ".csv", mimeType: "text/csv", text: lines.join("\n") + "\n" } }] }, { timeout: 600000 });
    state.note = out && out.isError ? "The download didn't finish." : "";
  } catch (err) {
    state.note = "The download couldn't be prepared: " + (err && err.message ? err.message : err);
  }
  state.busy = false; render();
}

function renderPull() {
  const p = state.pull;
  const total = p.total || 0;
  const line = total ? nf.format(p.done) + " of " + nf.format(total) + " creators" : "starting";
  const words = { running: "Pulling", paused: "Paused: the account is out of credits", cancelled: "Cancelled", partial: "Finished with some failures", done: "Finished" };
  return el("div", { class: "msg" },
    el("div", {}, (words[p.status] || p.status) + " · " + line + " · " + nf.format(p.credits) + " credits"),
    p.status === "running" ? el("div", {}, el("progress", total ? { max: total, value: p.done } : {})) : null);
}

function renderTable() {
  const t = state.table;
  const canDownload = !!(app.getHostCapabilities && app.getHostCapabilities() && app.getHostCapabilities().downloadFile);
  const filter = el("input", { id: "filter", type: "text", value: state.typed, placeholder: 'Filter, for example: followers > 50000 and contains(bio, "skincare")', "aria-label": "Filter rows",
    oninput: (e) => { state.typed = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter") { state.where = state.typed.trim(); state.offset = 0; load(); } } });
  const head = el("tr", {}, state.columns.map((c, i) => {
    const s = state.sort[0];
    const mark = s && s.by === BT + c + BT ? (s.desc ? " ▼" : " ▲") : "";
    return el("th", { class: i === 0 ? "n" : "", title: "Sort by " + c, onclick: () => (i === 0 ? null : sortBy(c)) }, c + mark);
  }));
  const body = state.rows.map((row) => el("tr", {}, row.map((cell) =>
    el("td", { class: typeof cell === "number" ? "n" : "", title: cell == null ? "" : String(cell) },
      cell == null ? "" : typeof cell === "number" ? nf.format(cell) : String(cell)))));
  const from = state.matched ? state.offset + 1 : 0;
  const to = Math.min(state.offset + state.rows.length, state.matched);
  return [
    el("div", { class: "bar" },
      el("div", { class: "title", title: t.name }, t.name),
      filter,
      el("button", { onclick: () => { state.where = state.typed.trim(); state.offset = 0; load(); }, disabled: state.busy }, "Filter"),
      canDownload ? el("button", { onclick: download, disabled: state.busy }, "Download CSV") : null),
    state.error ? el("div", { class: "err" }, state.error) : null,
    el("div", { class: "wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, body))),
    el("div", { class: "foot" },
      el("span", { class: "grow" }, state.note || ("Rows " + nf.format(from) + " to " + nf.format(to) + " of " + nf.format(state.matched) +
        (state.where ? " matching the filter" : ""))),
      el("button", { onclick: () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); load(); }, disabled: state.busy || state.offset === 0 }, "Previous"),
      el("button", { onclick: () => { state.offset += PAGE_SIZE; load(); }, disabled: state.busy || to >= state.matched }, "Next")),
  ];
}

function render() {
  const parts = [];
  if (state.pull && (state.pull.status !== "done" || !state.table)) parts.push(renderPull());
  if (state.table) parts.push(...renderTable());
  if (!parts.length) parts.push(el("div", { class: "msg" }, state.error || "Nothing to show yet."));
  // Redrawing replaces the filter box, so put the cursor back if the person was typing in it.
  const typing = document.activeElement && document.activeElement.id === "filter";
  root.replaceChildren(...parts.filter(Boolean));
  if (typing) {
    const box = document.getElementById("filter");
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }
}

function onResult(result) {
  const sc = result && result.structuredContent;
  if (!sc) {
    // A reply with no table, such as an error. Show its first line, and only when no table is open.
    if (!state.table) { state.error = (textOf(result) || "This reply has no table.").split("\n")[0].slice(0, 300); render(); }
    return;
  }
  if (sc.pull) state.pull = sc.pull;
  if (sc.table) {
    const first = !state.table || state.table.dataset !== sc.table.dataset;
    state.table = sc.table;
    if (first) { state.where = sc.table.where || ""; state.typed = state.where; state.sort = sc.table.sort || []; state.offset = 0; }
    load();
  } else {
    render();
  }
  clearTimeout(pollTimer);
  if (state.pull && state.pull.status === "running") {
    pollTimer = setTimeout(async () => {
      try { onResult(await app.callServerTool({ name: "pull_status", arguments: { pull: state.pull.id } })); }
      catch (err) { state.error = "Progress could not be checked."; render(); }
    }, 4000);
  }
}

app.ontoolresult = onResult;
await app.connect();
render();
</script>
</body></html>`;
