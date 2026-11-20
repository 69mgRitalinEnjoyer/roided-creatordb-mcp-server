import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let http: Server;
let base: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  env = await makeEnv({ publicUrl: base });
  const app = buildApp({ db: env.db, cfg: env.cfg, runner: env.runner, upstream: env.fake.fetch });
  await new Promise<void>((resolve) => {
    http = app.listen(port, () => resolve());
  });
});
afterAll(async () => {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await env.close();
});

async function mcpClient(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual' };
}

describe('the HTTP server', () => {
  it('answers health checks and serves the table script to other origins', async () => {
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toMatchObject({ status: 'ok', server: 'roided-mcp' });
    const svg = await fetch(`${base}/assets/icon.svg`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('<svg');
    const png = await fetch(`${base}/favicon.ico`);
    expect(png.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    const script = await fetch(`${base}/assets/ext-apps.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    expect(await script.text()).toContain('as App');
  });

  it('turns away a request with no sign-in and says where to sign in', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`${base}/.well-known/oauth-protected-resource/mcp`);
    const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string };
    expect(resource.resource).toBe(`${base}/mcp`);
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });

  it('accepts a raw API key in a header, as the official server does', async () => {
    const client = await mcpClient({ 'X-Creatordb-Api-Key': 'key-raw-0001' });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(62);
    const out = await client.callTool({ name: 'get_tiktok_profile', arguments: { uniqueId: 'creator_0005' } });
    expect((out.content as Array<{ text: string }>)[0]!.text).toContain('"totalFollowers":5000');
    await client.close();
    await expect(mcpClient({ 'X-Creatordb-Api-Key': 'bad-key' })).rejects.toThrow();
  });
});

describe('sign-in with a pasted key', () => {
  const redirect = 'http://localhost:9999/callback';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let clientId: string;
  let tokens: { access_token: string; refresh_token: string; expires_in: number };

  async function authorizeFields(): Promise<Record<string, string>> {
    return { client_id: clientId, redirect_uri: redirect, code_challenge: challenge, state: 'state-123' };
  }

  it('registers a client and shows the key page, which no other site may frame', async () => {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Test client', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    expect(reg.status).toBe(201);
    clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123' })}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('Paste your CreatorDB V3 API key');
  });

  it('refuses a key CreatorDB rejects, and a return address the client never registered', async () => {
    const bad = await fetch(`${base}/authorize/submit`, form({ ...(await authorizeFields()), api_key: 'bad-key' }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('accept that key. Check it and try again.');
    const elsewhere = await fetch(`${base}/authorize/submit`, form({ ...(await authorizeFields()), redirect_uri: 'https://evil.example/cb', api_key: 'key-oauth-0001' }));
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();
  });

  it('issues tokens for a good key and signs the tools in with them', async () => {
    const submitted = await fetch(`${base}/authorize/submit`, form({ ...(await authorizeFields()), api_key: 'key-oauth-0001' }));
    expect(submitted.status).toBe(302);
    const back = new URL(submitted.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('state')).toBe('state-123');
    const code = back.searchParams.get('code')!;

    const wrong = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'not-the-verifier-not-the-verifier-not-the-verifier', client_id: clientId, redirect_uri: redirect }));
    expect(wrong.status).toBe(400);

    const res = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));
    expect(res.status).toBe(200);
    tokens = (await res.json()) as typeof tokens;
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token).not.toContain('key-oauth-0001');

    const replay = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));
    expect(replay.status).toBe(400);

    // The key is not in the token. The server reads it back from the workspace, encrypted at rest.
    const stored = await env.db.query<{ key_cipher: string }>('select key_cipher from workspaces');
    expect(stored.rows.every((r) => !r.key_cipher.includes('key-oauth-0001'))).toBe(true);
    const client = await mcpClient({ Authorization: `Bearer ${tokens.access_token}` });
    const out = await client.callTool({ name: 'get_instagram_profile', arguments: { uniqueId: 'creator_0011' } });
    expect((out.content as Array<{ text: string }>)[0]!.text).toContain('"uniqueId":"creator_0011"');
    await client.close();
  });

  it('rotates refresh tokens and cancels the connection when an old one comes back', async () => {
    const first = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(first.status).toBe(200);
    const fresh = (await first.json()) as typeof tokens;
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token);
    // The access token from before the refresh stops working.
    await expect(mcpClient({ Authorization: `Bearer ${tokens.access_token}` })).rejects.toThrow();
    const ok = await mcpClient({ Authorization: `Bearer ${fresh.access_token}` });
    await ok.close();

    const reused = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(reused.status).toBe(400);
    await expect(mcpClient({ Authorization: `Bearer ${fresh.access_token}` })).rejects.toThrow();
  });
});

describe('files and uploads over HTTP', () => {
  it('serves a result file only through its signed link', async () => {
    const client = await mcpClient({ 'X-Creatordb-Api-Key': 'key-files-0001' });
    const made = await client.callTool({ name: 'import_list', arguments: { name: 'Link test', handles: ['creator_0001', 'creator_0002'], upload: true } });
    const text = (made.content as Array<{ text: string }>)[0]!.text;
    const id = Number(/dataset (\d+)/.exec(text)![1]);

    const uploadUrl = /upload\s+(http\S+)/.exec(text)![1]!;
    expect((await fetch(uploadUrl)).status).toBe(200);
    const uploaded = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'handle,notes\ncreator_0002,dup\nhttps://www.tiktok.com/@creator_0003,new\ncreator_0004,new\n' });
    expect(await uploaded.text()).toContain('Added 2 creators (1 were already in the list)');
    expect((await fetch(uploadUrl, { method: 'POST', body: 'creator_0009' })).status).toBe(403);

    const exported = await client.callTool({ name: 'export_dataset', arguments: { dataset: id } });
    const link = /file\s+(http\S+)/.exec((exported.content as Array<{ text: string }>)[0]!.text)![1]!;
    const file = await fetch(link);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('Link test');
    const csv = (await file.text()).trim().split('\n');
    expect(csv).toHaveLength(5);
    expect(csv.join('\n')).toContain('@creator_0003');
    expect((await fetch(link.replace(/sig=.{6}/, 'sig=AAAAAA'))).status).toBe(403);
    expect((await fetch(link.replace(/expires=\d+/, 'expires=1'))).status).toBe(403);
    await client.close();
  });
});

/** What an MCP client such as Claude keeps between the steps of a sign-in. */
class MemoryAuth implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  /** Where the client would send the person's browser. */
  authorizationUrl?: URL;
  get redirectUrl(): string {
    return 'http://localhost:9911/callback';
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

describe('sign-in the way Claude does it', () => {
  it('goes from just the server address to the key page to a signed-in client', async () => {
    // The client is given nothing but the address. It finds the sign-in endpoints and registers itself.
    const auth = new MemoryAuth();
    const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: auth });
    await expect(new Client({ name: 'sdk-oauth', version: '0' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(auth.authorizationUrl?.origin + auth.authorizationUrl!.pathname).toBe(`${base}/authorize`);
    expect(auth.authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');

    // The person's browser opens the page, they paste their key and press Connect.
    const page = await fetch(auth.authorizationUrl!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Paste your CreatorDB V3 API key');
    const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]));
    const submitted = await fetch(`${base}/authorize/submit`, form({ ...fields, api_key: 'key-from-the-page-1' }));
    expect(submitted.status).toBe(302);
    const back = new URL(submitted.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(auth.redirectUrl);
    expect(back.searchParams.get('state')).toBe(auth.authorizationUrl!.searchParams.get('state'));

    // Back in the client: it swaps the code for tokens and connects.
    await first.finishAuth(back.searchParams.get('code')!);
    expect(auth.saved?.access_token).toBeTruthy();
    expect(JSON.stringify(auth.saved)).not.toContain('key-from-the-page-1');
    const client = new Client({ name: 'sdk-oauth', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: auth }));
    expect((await client.listTools()).tools).toHaveLength(62);
    const out = await client.callTool({ name: 'get_youtube_profile', arguments: { uniqueId: '@creator_0021' } });
    expect((out.content as Array<{ text: string }>)[0]!.text).toContain('"totalSubscribers":21000');
    await client.close();
  });
});
