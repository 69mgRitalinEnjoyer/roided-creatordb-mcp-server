import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { callContext, isEnvelope, type ApiEnvelope, type CapturedReply } from '../context.js';
import { json, type Db } from '../db/client.js';
import { Limiter } from './limiter.js';

/**
 * The official tool code is pointed at this address through its `CREATORDB_API_BASE` setting.
 * Nothing listens there. `installGateway` catches the request before it leaves the process.
 */
export const GATEWAY_ORIGIN = 'http://creatordb-gateway.internal';

type Fetch = typeof fetch;

export interface GatewayDeps {
  db: Db;
  cfg: Config;
  /** How the gateway reaches the real CreatorDB. Tests pass a fake. */
  upstream: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface UpstreamReply {
  status: number;
  contentType: string;
  text: string;
  parsed: ApiEnvelope | unknown[] | null;
}

const RATE_LIMIT_CODES = /RATE_?LIMIT|TOO_MANY|THROTTL/i;
const OUT_OF_CREDIT_CODES = /INSUFFICIENT|OUT_OF_CREDIT|QUOTA_EXCEEDED|NO_CREDIT|PAYMENT_REQUIRED/i;

function errorEnvelope(code: string, description: string): string {
  return JSON.stringify({
    data: null,
    creditsUsed: 0,
    creditsAvailable: -1,
    traceId: '',
    timestamp: Date.now(),
    errorCode: code,
    errorDescription: description,
    success: false,
  });
}

function jsonResponse(text: string, status: number, contentType = 'application/json'): Response {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

function parseBody(text: string): ApiEnvelope | unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value;
    return isEnvelope(value) ? value : null;
  } catch {
    // A streamed reply: the last `data:` line that parses is the result.
    let last: ApiEnvelope | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const value: unknown = JSON.parse(line.slice(6).trim());
        if (isEnvelope(value)) last = value;
      } catch {
        // progress lines are not JSON
      }
    }
    return last;
  }
}

/**
 * The only code that calls CreatorDB. For every call it waits for a turn, retries when told to
 * slow down, saves the raw reply with its charge, and passes the reply on untouched.
 */
export class Gateway {
  private readonly limiter: Limiter;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GatewayDeps) {
    this.limiter = new Limiter(deps.cfg.maxInFlight, deps.cfg.lookupReserve);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async handle(url: URL, init: RequestInit = {}): Promise<Response> {
    const ctx = callContext.getStore();
    if (!ctx) {
      return jsonResponse(errorEnvelope('NO_WORKSPACE', 'This request did not come from a signed-in tool call.'), 401);
    }

    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    const path = url.pathname + url.search;
    const requestHash = createHash('sha256').update(`${method}\n${path}\n${body ?? ''}`).digest('hex');

    // A retried chunk of a whole-list pull reuses what it already paid for.
    if (ctx.pullId !== undefined) {
      const saved = await this.deps.db.query<{ id: number; status: number; response: unknown; response_text: string | null }>(
        `select id, status, response, response_text from raw_replies
          where pull_id = $1 and request_hash = $2 and workspace_id = $3 and ok
          order by id desc limit 1`,
        [ctx.pullId, requestHash, ctx.workspaceId],
      );
      const hit = saved.rows[0];
      if (hit) {
        const text = hit.response_text ?? JSON.stringify(hit.response);
        const parsed = parseBody(text);
        ctx.capture.push({ replyId: hit.id, method, path: url.pathname, status: hit.status, envelope: parsed, creditsUsed: 0, reused: true });
        return jsonResponse(text, hit.status);
      }
    }

    const release = await this.limiter.acquire(ctx.workspaceId, ctx.priority);
    let reply: UpstreamReply;
    try {
      reply = await this.callUpstream(method, path, body, ctx.apiKey);
    } finally {
      release();
    }

    const envelope = isEnvelope(reply.parsed) ? reply.parsed : null;
    const ok = reply.status < 400 && (Array.isArray(reply.parsed) || envelope?.success !== false);
    const creditsUsed = typeof envelope?.creditsUsed === 'number' ? envelope.creditsUsed : 0;
    if (!ok && (reply.status === 402 || OUT_OF_CREDIT_CODES.test(String(envelope?.errorCode ?? '')))) {
      ctx.outOfCredits = true;
    }

    // Save before answering, so a closed chat or a crashed worker cannot lose paid-for data.
    const saved = await this.deps.db.query<{ id: number }>(
      `insert into raw_replies (workspace_id, pull_id, request_hash, method, path, request, status, ok, response, response_text, credits_used)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11) returning id`,
      [
        ctx.workspaceId,
        ctx.pullId ?? null,
        requestHash,
        method,
        url.pathname,
        json({ query: Object.fromEntries(url.searchParams), body: body ? safeParse(body) : null }),
        reply.status,
        ok,
        reply.parsed === null ? null : json(reply.parsed),
        reply.parsed === null ? reply.text : null,
        creditsUsed,
      ],
    );
    if (ctx.pullId !== undefined && creditsUsed > 0) {
      await this.deps.db.query('update pulls set credits = credits + $1, updated_at = now() where id = $2', [creditsUsed, ctx.pullId]);
    }

    const captured: CapturedReply = {
      replyId: saved.rows[0]!.id,
      method,
      path: url.pathname,
      status: reply.status,
      envelope: reply.parsed,
      creditsUsed,
      reused: false,
    };
    ctx.capture.push(captured);
    return jsonResponse(reply.text, reply.status, reply.contentType);
  }

  private async callUpstream(method: string, path: string, body: string | undefined, apiKey: string): Promise<UpstreamReply> {
    const { cfg } = this.deps;
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= cfg.maxTries; attempt++) {
      try {
        const res = await this.deps.upstream(cfg.upstreamBase + path, {
          method,
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        });
        const text = await res.text();
        const parsed = parseBody(text);
        const code = isEnvelope(parsed) ? String(parsed.errorCode ?? '') : '';
        const slowDown = res.status === 429 || (isEnvelope(parsed) && parsed.success === false && RATE_LIMIT_CODES.test(code));
        if (slowDown && attempt < cfg.maxTries) {
          await this.backoff(attempt);
          continue;
        }
        if (res.status >= 500 && attempt < cfg.maxTries) {
          lastError = `CreatorDB answered ${res.status}`;
          await this.backoff(attempt);
          continue;
        }
        return { status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', text, parsed };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < cfg.maxTries) await this.backoff(attempt);
      }
    }
    const text = errorEnvelope('UPSTREAM_UNREACHABLE', `CreatorDB could not be reached after ${cfg.maxTries} tries: ${lastError}`);
    return { status: 502, contentType: 'application/json', text, parsed: parseBody(text) };
  }

  /** 1, 2, 4, 8 seconds and so on, with a random extra so workers don't all retry together. */
  private backoff(attempt: number): Promise<void> {
    const base = this.deps.cfg.backoffBaseMs * 2 ** (attempt - 1);
    return this.sleep(base + Math.floor(Math.random() * base * 0.25));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let installed: { gateway: Gateway; real: Fetch } | null = null;

/**
 * Routes every request aimed at `GATEWAY_ORIGIN` into the gateway and leaves all other requests
 * alone. Returns the untouched `fetch`, which the gateway itself uses to reach CreatorDB.
 */
export function installGateway(makeGateway: (realFetch: Fetch) => Gateway): Gateway {
  const real = installed?.real ?? globalThis.fetch;
  const gateway = makeGateway(real);
  installed = { gateway, real };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith(GATEWAY_ORIGIN) && installed) {
      const merged: RequestInit =
        init ?? (input instanceof Request ? { method: input.method, body: await input.text() } : {});
      return installed.gateway.handle(new URL(raw), merged);
    }
    return real(input as RequestInfo, init);
  }) as Fetch;
  return gateway;
}
