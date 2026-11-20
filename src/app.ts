import { createReadStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import express, { type Express, type Request, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sha256 } from './auth/crypto.js';
import { createProvider } from './auth/provider.js';
import { workspaceKey } from './auth/workspaces.js';
import { buildMcpServer, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, type ServerDeps } from './server.js';
import { ICON_PNG, ICON_SVG } from './ui/icon.js';
import { appendRows, existingKeys } from './workspace/datasets.js';
import { verifyFileLink } from './workspace/files.js';

export interface AppDeps extends ServerDeps {
  /** How to reach the real CreatorDB, for checking a key at sign-in. */
  upstream: typeof fetch;
}

const requireFromHere = createRequire(import.meta.url);

/** The browser half of the MCP Apps SDK, which the live table loads from this server. */
function extAppsBundle(): string {
  const server = requireFromHere.resolve('@modelcontextprotocol/ext-apps/server');
  return server.replace(/server[\\/]index\.js$/, 'app-with-deps.js');
}

const UPLOAD_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload a creator list</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}
button{padding:.6rem 1rem;border-radius:8px;border:0;background:#1a1a1a;color:#fff;font-weight:600;cursor:pointer}#out{margin-top:1rem;color:#555}</style></head>
<body><h1>Upload a creator list</h1>
<p>Pick a CSV or text file. The first column should hold the handles, channel IDs or profile links, one per line.</p>
<input id="file" type="file" accept=".csv,.txt,text/csv,text/plain"> <button id="go">Upload</button><div id="out"></div>
<script>
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out'); const file = document.getElementById('file').files[0];
  if (!file) { out.textContent = 'Pick a file first.'; return; }
  out.textContent = 'Uploading…';
  const res = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
  out.textContent = await res.text();
};
</script></body></html>`;

function parseHandles(csv: string): string[] {
  const lines = csv.split(/\r?\n/).map((line) => (line.split(',')[0] ?? '').trim().replace(/^"|"$/g, ''));
  const first = lines[0]?.toLowerCase() ?? '';
  const body = /^(handle|handles|username|user|creator|channel|channel ?id|url|link|profile|id|uniqueid)$/.test(first) ? lines.slice(1) : lines;
  const seen = new Map<string, string>();
  for (const raw of body) {
    let h = raw;
    if (h.includes('/')) {
      const segments = h.split(/[?#]/)[0]!.split('/').filter(Boolean);
      if (segments.length) h = segments[segments.length - 1]!;
    }
    if (h) seen.set(h.toLowerCase(), h);
  }
  return [...seen.values()];
}

export function buildApp(deps: AppDeps): Express {
  const { db, cfg } = deps;
  const provider = createProvider(deps);
  const app = express();
  // One proxy hop, as on Cloud Run, so rate limits see the caller's address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // One line per request: method, path, status and time. Never the query string or the body,
  // and never an upload token, so no key, sign-in code or link signature reaches the logs.
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const started = Date.now();
    const path = req.path.replace(/^\/upload\/.+/, '/upload/[token]');
    res.on('finish', () => {
      // For MCP calls, the method name and protocol version help when a client and the server disagree.
      const rpc = req.path === '/mcp' && req.body && typeof req.body.method === 'string' ? ` ${req.body.method}` : '';
      const version = req.path === '/mcp' && req.header('mcp-protocol-version') ? ` v${req.header('mcp-protocol-version')}` : '';
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms${rpc}${version}`);
    });
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Sign-in: /authorize, /token, /register, /revoke and the discovery documents.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(cfg.publicUrl),
      baseUrl: new URL(cfg.publicUrl),
      resourceServerUrl: new URL(`${cfg.publicUrl}/mcp`),
      scopesSupported: [],
      resourceName: SERVER_TITLE,
    }),
  );
  app.post('/authorize/submit', (req, res) => {
    provider.submit(req, res).catch((err) => {
      console.error('[auth] sign-in failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).send('Sign-in failed. Start the connection again from Claude.');
    });
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.get('/', (_req, res) => {
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${SERVER_TITLE}</title><link rel="icon" type="image/svg+xml" href="/assets/icon.svg"></head>` +
          `<body style="font-family:system-ui;max-width:640px;margin:4rem auto;padding:0 1rem;line-height:1.6">` +
          `<img src="/assets/icon.svg" alt="" width="96" height="96"><h1>${SERVER_TITLE}</h1>` +
          `<p>The CreatorDB MCP, with a server-side workspace.</p>` +
          `<p>Add this server to Claude as a custom connector with the URL <code>${cfg.publicUrl}/mcp</code>. ` +
          `On connect you paste your CreatorDB V3 API key.</p></body></html>`,
      );
  });

  // The logo. Clients read it from the server's icons, and browsers and favicon fetchers from /favicon.ico.
  app.get('/assets/icon.svg', (_req, res) => {
    res.set('Content-Type', 'image/svg+xml').set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=86400').send(ICON_SVG);
  });
  app.get(['/assets/icon.png', '/favicon.ico'], (_req, res) => {
    res.set('Content-Type', 'image/png').set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=86400').send(ICON_PNG);
  });

  // The live table loads this script from inside Claude's sandboxed frame, which is another origin.
  app.get('/assets/ext-apps.js', (_req, res) => {
    res.set('Content-Type', 'text/javascript; charset=utf-8').set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=86400');
    createReadStream(extAppsBundle()).pipe(res);
  });

  // Result files. The link itself is the permission: it is signed and it expires.
  app.get('/files/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!verifyFileLink(cfg, id, req.query.expires as string | undefined, req.query.sig as string | undefined)) {
      res.status(403).send('This link has expired or is not valid. Ask for the file again.');
      return;
    }
    const found = await db.query<{ name: string; path: string }>('select name, path from files where id = $1', [id]);
    const file = found.rows[0];
    if (!file || !existsSync(file.path)) {
      res.status(404).send('This file is no longer available. Ask for it again.');
      return;
    }
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`)
      .set('Cache-Control', 'private, no-store');
    createReadStream(file.path).pipe(res);
  });

  // CSV upload for import_list. The link works once, for one hour.
  app.get('/upload/:token', (_req, res) => {
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').set('X-Frame-Options', 'DENY').send(UPLOAD_PAGE);
  });
  app.post('/upload/:token', express.text({ type: () => true, limit: '20mb' }), async (req: Request, res: Response) => {
    const claimed = await db.query<{ workspace_id: string; dataset_id: number }>(
      'update uploads set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning workspace_id, dataset_id',
      [sha256(String(req.params.token))],
    );
    const upload = claimed.rows[0];
    if (!upload) {
      res.status(403).send('This upload link has expired or was already used. Ask Claude for a new one.');
      return;
    }
    const handles = parseHandles(typeof req.body === 'string' ? req.body : '');
    const added = await db.asWorkspace(upload.workspace_id, async (q) => {
      const have = await existingKeys(q, upload.workspace_id, upload.dataset_id, handles);
      const fresh = handles.filter((h) => !have.has(h));
      await appendRows(q, upload.workspace_id, upload.dataset_id, fresh.map((h) => ({ key: h, data: /^UC[\w-]{22}$/.test(h) ? { channelId: h } : { uniqueId: h } })));
      return fresh.length;
    });
    res.status(200).send(`Added ${added} creators (${handles.length - added} were already in the list). You can close this page and go back to Claude.`);
  });

  // The MCP endpoint. A raw key in X-Creatordb-Api-Key works as on the official server.
  app.use('/mcp', (req, _res, next) => {
    if (!req.headers.authorization) {
      const rawKey = req.header('x-creatordb-api-key');
      if (rawKey) req.headers.authorization = `Bearer ${rawKey}`;
    }
    next();
  });
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`,
  });
  app.all('/mcp', bearer, async (req, res) => {
    const auth = (req as unknown as { auth?: { extra?: Record<string, unknown> } }).auth;
    const workspaceId = auth?.extra?.workspaceId as string | undefined;
    if (!workspaceId) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'No workspace resolved from the credentials.' }, id: null });
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      const apiKey = (auth?.extra?.apiKey as string | undefined) ?? (await workspaceKey(db, cfg, workspaceId));
      const server = await buildMcpServer(deps, { workspaceId, apiKey });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] transport error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP transport error' }, id: null });
      }
    } finally {
      void transport.close().catch(() => {});
    }
  });

  return app;
}
