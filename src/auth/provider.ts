/**
 * Sign-in. The flow and the paste-your-key page are adapted from the official CreatorDB MCP
 * server (functions/src/oauth-provider.ts, MIT License, Copyright (c) 2026 CreatorDB).
 *
 * What differs: the official server seals the API key inside its tokens and keeps no records.
 * This server keeps the key encrypted in the workspace, because whole-list pulls outlive the
 * request that started them, and it keeps tokens in the database so they can be cancelled.
 * Access tokens last an hour. Refresh tokens are single-use and expire after 90 idle days.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { open, randomToken, seal, sha256 } from './crypto.js';
import { ensureWorkspace, findWorkspace, keyIsValid } from './workspaces.js';

const AUTH_CODE_TTL_SEC = 5 * 60;

/**
 * Tokens this server issues carry a prefix. An expired or cancelled one is then refused at once,
 * and is never mistaken for a raw API key and sent on to CreatorDB.
 */
const ACCESS_PREFIX = 'cdbw_at_';
const REFRESH_PREFIX = 'cdbw_rt_';

export interface AuthDeps {
  db: Db;
  cfg: Config;
  upstream: typeof fetch;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface PageParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
  error?: string;
}

export function renderAuthorizePage(params: PageParams): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect Roided MCP</title>
  <link rel="icon" type="image/svg+xml" href="/assets/icon.svg" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f7f7f8; color: #1a1a1a; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
    .card { background: #fff; max-width: 440px; width: 100%; margin: 1rem; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    p { color: #555; font-size: 0.9rem; line-height: 1.5; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin: 1.25rem 0 0.4rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { margin-top: 1.25rem; width: 100%; padding: 0.65rem; background: #1a1a1a; color: #fff; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #000; }
    .hint { font-size: 0.78rem; color: #888; margin-top: 1rem; }
    .error { color: #b3261e; font-size: 0.88rem; margin-top: 1rem; }
    a { color: #0070f3; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/assets/icon.svg" alt="" width="56" height="56" style="margin:-0.5rem 0 0.5rem -0.5rem" />
    <h1>Connect Roided MCP</h1>
    <p>Paste your CreatorDB V3 API key to authorize this connection. The key is used to make your requests to CreatorDB, and your workspace of saved results belongs to it.</p>
    ${params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : ''}
    <form method="POST" action="/authorize/submit">
      ${hidden('client_id', params.clientId)}
      ${hidden('redirect_uri', params.redirectUri)}
      ${hidden('code_challenge', params.codeChallenge)}
      ${hidden('state', params.state)}
      ${hidden('scope', params.scope)}
      ${hidden('resource', params.resource)}
      <label for="api_key">CreatorDB API key</label>
      <input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="your CreatorDB key" required />
      <button type="submit">Connect</button>
    </form>
    <p class="hint">This server stores your key encrypted, because a large pull keeps running after your request ends. Disconnecting the connector cancels its access.</p>
    <p class="hint">Don't have a key? Get one at <a href="https://app.creatordb.app" target="_blank" rel="noopener">app.creatordb.app</a>.</p>
  </div>
</body>
</html>`;
}

function sendPage(res: Response, status: number, params: PageParams): void {
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    // The page takes a secret, so no other site may show it inside a frame.
    .set('X-Frame-Options', 'DENY')
    .set('Content-Security-Policy', "frame-ancestors 'none'")
    .set('Cache-Control', 'no-store')
    .send(renderAuthorizePage(params));
}

export interface Provider extends OAuthServerProvider {
  /** Handles the paste-your-key form. */
  submit(req: Request, res: Response): Promise<void>;
}

export function createProvider(deps: AuthDeps): Provider {
  const { db, cfg } = deps;
  const secret = cfg.tokenSecret;

  const clientsStore: OAuthRegisteredClientsStore = {
    // A client ID is an encrypted copy of the registration, so no table of clients is needed.
    async getClient(clientId) {
      try {
        const c = open<{ redirect_uris: string[] }>(secret, 'client', clientId);
        return {
          client_id: clientId,
          redirect_uris: c.redirect_uris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        };
      } catch {
        return undefined;
      }
    },
    async registerClient(client) {
      const clientId = seal(secret, 'client', { redirect_uris: client.redirect_uris });
      return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
  };

  async function issueTokens(grantId: string): Promise<OAuthTokens> {
    const access = ACCESS_PREFIX + randomToken();
    const refresh = REFRESH_PREFIX + randomToken();
    await db.query(
      `insert into oauth_tokens (token_hash, grant_id, kind, expires_at) values
         ($1, $3, 'access', now() + ($4::int * interval '1 second')),
         ($2, $3, 'refresh', now() + ($5::int * interval '1 second'))`,
      [sha256(access), sha256(refresh), grantId, cfg.accessTokenTtlSec, cfg.refreshIdleTtlSec],
    );
    return { access_token: access, token_type: 'bearer', expires_in: cfg.accessTokenTtlSec, refresh_token: refresh, scope: '' };
  }

  async function revokeGrant(grantId: string): Promise<void> {
    await db.query('update oauth_grants set revoked_at = now() where id = $1', [grantId]);
    await db.query('delete from oauth_tokens where grant_id = $1', [grantId]);
  }

  return {
    clientsStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
      sendPage(res, 200, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scope: params.scopes?.join(' '),
        resource: params.resource?.href,
      });
    },

    async submit(req, res) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const field = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : undefined);
      const page: PageParams = {
        clientId: field('client_id') ?? '',
        redirectUri: field('redirect_uri') ?? '',
        codeChallenge: field('code_challenge') ?? '',
        state: field('state'),
        scope: field('scope'),
        resource: field('resource'),
      };
      const apiKey = field('api_key')?.trim();
      // The form's hidden fields can be edited, so the client and its return address are checked again.
      const client = page.clientId ? await clientsStore.getClient(page.clientId) : undefined;
      if (!apiKey || !client || !page.codeChallenge || !client.redirect_uris.includes(page.redirectUri)) {
        res.status(400).send('This sign-in link is incomplete or out of date. Start the connection again from Claude.');
        return;
      }
      const known = await findWorkspace(db, apiKey);
      if (!known && !(await keyIsValid(cfg, deps.upstream, apiKey))) {
        sendPage(res, 400, { ...page, error: "CreatorDB didn't accept that key. Check it and try again." });
        return;
      }
      const workspaceId = await ensureWorkspace(db, cfg, apiKey);
      const code = seal(secret, 'code', {
        workspaceId,
        codeChallenge: page.codeChallenge,
        redirectUri: page.redirectUri,
        clientId: page.clientId,
        exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SEC,
      });
      const target = new URL(page.redirectUri);
      target.searchParams.set('code', code);
      if (page.state) target.searchParams.set('state', page.state);
      res.redirect(302, target.href);
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      try {
        return open<{ codeChallenge: string }>(secret, 'code', authorizationCode).codeChallenge;
      } catch {
        throw new InvalidGrantError('The authorization code is invalid or has expired.');
      }
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
      // The SDK checks the PKCE verifier against challengeForAuthorizationCode before this runs.
      let code: { workspaceId: string; redirectUri: string; clientId: string };
      try {
        code = open(secret, 'code', authorizationCode);
      } catch {
        throw new InvalidGrantError('The authorization code is invalid or has expired.');
      }
      if (code.clientId !== client.client_id) throw new InvalidGrantError('The authorization code belongs to another client.');
      if (redirectUri !== undefined && redirectUri !== code.redirectUri) throw new InvalidGrantError('redirect_uri does not match.');
      const first = await db.query('insert into oauth_codes_used (code_hash) values ($1) on conflict do nothing returning code_hash', [
        sha256(authorizationCode),
      ]);
      if (first.rows.length === 0) throw new InvalidGrantError('The authorization code was already used.');
      const grantId = randomUUID();
      await db.query('insert into oauth_grants (id, workspace_id, client_id) values ($1, $2, $3)', [grantId, code.workspaceId, client.client_id]);
      return issueTokens(grantId);
    },

    async exchangeRefreshToken(_client, refreshToken) {
      const found = await db.query<{ grant_id: string; used_at: string | null; expired: boolean; revoked: boolean }>(
        `select t.grant_id, t.used_at, t.expires_at < now() as expired, g.revoked_at is not null as revoked
           from oauth_tokens t join oauth_grants g on g.id = t.grant_id
          where t.token_hash = $1 and t.kind = 'refresh'`,
        [sha256(refreshToken)],
      );
      const token = found.rows[0];
      if (!token || token.revoked || token.expired) throw new InvalidGrantError('The refresh token is invalid or has expired.');
      if (token.used_at) {
        // A refresh token is good for one use. Seeing it twice means a copy leaked, so the whole connection is cancelled.
        await revokeGrant(token.grant_id);
        throw new InvalidGrantError('The refresh token was already used. Connect again.');
      }
      await db.query("delete from oauth_tokens where grant_id = $1 and kind = 'access'", [token.grant_id]);
      await db.query('update oauth_tokens set used_at = now() where token_hash = $1', [sha256(refreshToken)]);
      return issueTokens(token.grant_id);
    },

    async verifyAccessToken(token): Promise<AuthInfo> {
      const found = await db.query<{ workspace_id: string; client_id: string; expires: number }>(
        `select g.workspace_id, g.client_id, extract(epoch from t.expires_at)::bigint as expires
           from oauth_tokens t join oauth_grants g on g.id = t.grant_id
          where t.token_hash = $1 and t.kind = 'access' and t.expires_at > now() and g.revoked_at is null`,
        [sha256(token)],
      );
      const row = found.rows[0];
      if (row) {
        return { token, clientId: row.client_id, scopes: [], expiresAt: Number(row.expires), extra: { workspaceId: row.workspace_id } };
      }
      if (token.startsWith(ACCESS_PREFIX) || token.startsWith(REFRESH_PREFIX)) throw new InvalidTokenError('Invalid or expired token.');
      // A raw CreatorDB key sent as the bearer, for scripts and for Claude Code. A key that has no
      // workspace yet is checked with CreatorDB before one is made.
      let workspaceId = await findWorkspace(db, token);
      if (!workspaceId) {
        if (token.length < 8 || !(await keyIsValid(cfg, deps.upstream, token))) throw new InvalidTokenError('Invalid or expired token.');
        workspaceId = await ensureWorkspace(db, cfg, token);
      }
      return { token, clientId: 'raw-key', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { workspaceId, apiKey: token } };
    },

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
      const found = await db.query<{ grant_id: string }>('select grant_id from oauth_tokens where token_hash = $1', [sha256(request.token)]);
      if (found.rows[0]) await revokeGrant(found.rows[0].grant_id);
    },
  };
}
