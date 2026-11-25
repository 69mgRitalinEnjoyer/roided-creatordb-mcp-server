// Shows the live table in a plain browser, with a stand-in for Claude's app.
//
// Inside Claude the table talks to its host through the MCP Apps SDK. Here a small stub plays
// the host and serves 1,234 made-up rows, so the page's own behaviour (paging, sorting,
// filtering, downloading) can be checked without a deployed server.
//
//   npm run build && npm run preview:table

import { createServer } from 'node:http';
import { tableHtml } from '../dist/ui/table.js';

const PORT = Number(process.env.PORT ?? 8793);

const STUB = `
const COLUMNS = ['row', 'uniqueId', 'displayName', 'totalSubscribers', 'country', 'mainLanguage', 'bio', 'fit'];
const ROWS = Array.from({ length: 1234 }, (_, k) => {
  const i = k + 1;
  return [i, '@creator_' + String(i).padStart(4, '0'), 'Creator ' + i, ((i * 7919) % 990) * 1000 + 1000, i % 3 ? 'USA' : 'GBR', 'eng',
    i % 4 === 0 ? 'Skincare routines, SPF reviews and ingredient deep dives' : 'Daily vlogs and travel', i % 5 === 0 ? 'fit' : i % 5 === 1 ? 'maybe' : null];
});
export class App {
  constructor() { this.downloads = []; }
  getHostCapabilities() { return { downloadFile: {} }; }
  async connect() {
    setTimeout(() => this.ontoolresult && this.ontoolresult({
      content: [{ type: 'text', text: 'pull 7, finished' }],
      _meta: {
        'roided-mcp/view': {
          pull: { id: 7, status: 'done', done: 1234, total: 1234, failed: 0, credits: 864.5 },
          table: { dataset: 214, name: 'search_youtube: skincare, USA', rows: 1234, columns: COLUMNS.slice(1) },
        },
      },
    }), 30);
  }
  async callServerTool({ name, arguments: a }) {
    if (name !== 'table_rows') return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    let rows = ROWS;
    if (a.where) {
      const m = /^(\\w+)\\s*(>|<|=)\\s*"?([^"]+)"?$/.exec(a.where.trim());
      if (!m) return { isError: true, content: [{ type: 'text', text: 'The formula ends too early or has a symbol in the wrong place.' }] };
      const col = COLUMNS.indexOf(m[1] === 'followers' ? 'totalSubscribers' : m[1]);
      if (col < 0) return { isError: true, content: [{ type: 'text', text: '"' + m[1] + '" is not a column in this preview.' }] };
      const want = isNaN(Number(m[3])) ? m[3] : Number(m[3]);
      rows = rows.filter((r) => (m[2] === '>' ? r[col] > want : m[2] === '<' ? r[col] < want : r[col] === want));
    }
    if (a.sort && a.sort[0]) {
      const col = COLUMNS.indexOf(a.sort[0].by.replace(/\\x60/g, ''));
      const dir = a.sort[0].desc ? -1 : 1;
      rows = [...rows].sort((x, y) => (x[col] > y[col] ? dir : x[col] < y[col] ? -dir : 0));
    }
    const page = rows.slice(a.offset || 0, (a.offset || 0) + (a.limit || 100));
    return { content: [{ type: 'text', text: 'rows' }], structuredContent: { columns: COLUMNS, rows: page, matched: rows.length } };
  }
  async downloadFile(request) {
    this.downloads.push(request);
    window.lastDownload = request;
    return { isError: false };
  }
}
`;

createServer((req, res) => {
  if (req.url === '/stub-app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(STUB);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(tableHtml('/stub-app.js'));
  }
}).listen(PORT, () => console.log(`Live table preview: http://localhost:${PORT}`));
