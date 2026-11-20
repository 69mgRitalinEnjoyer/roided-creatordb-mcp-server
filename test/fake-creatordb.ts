/**
 * A stand-in for the CreatorDB API, so tests never spend credits. It serves made-up creators
 * and can be told to slow callers down or to run out of credits.
 */
export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Platform = 'youtube' | 'instagram' | 'tiktok';

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

export function handleOf(i: number): string {
  return `creator_${pad(i)}`;
}

export function channelIdOf(i: number): string {
  return `UC${String(i).padStart(22, 'a')}`;
}

export class FakeCreatorDb {
  readonly calls: FakeCall[] = [];
  /** How many creators exist on each platform. */
  size = 250;
  creditsAvailable = 1_000_000;
  creditsUsed = 0;
  /** The next N calls are answered with "slow down". */
  slowDownNext = 0;
  /** Milliseconds each call takes. */
  delayMs = 0;
  /** Paid calls, counted by endpoint and creator, to prove nothing is paid for twice. */
  readonly paid = new Map<string, number>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const headers = new Headers(init?.headers);
    this.calls.push({ method, path: url.pathname, body });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    if (headers.get('api-key') === 'bad-key') return this.fail(401, 'UNAUTHORIZED', 'Invalid API key');
    if (this.slowDownNext > 0) {
      this.slowDownNext--;
      return this.fail(429, 'RATE_LIMITED', 'Too many requests');
    }
    if (url.pathname === '/usage') return this.ok({ records: [] }, 0);

    const [, platform, endpoint] = url.pathname.split('/') as [string, Platform, string];
    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) return this.fail(404, 'NOT_FOUND', 'Unknown endpoint');
    if (endpoint === 'search') return this.search(platform, body ?? {});

    const index = this.indexOf(platform, body ?? Object.fromEntries(url.searchParams));
    if (index === null) return this.fail(404, 'NOT_FOUND', 'Creator not found');
    const fields = Array.isArray(body?.fields) ? (body.fields as string[]) : null;
    switch (endpoint) {
      case 'profile':
        return this.charge(`${url.pathname}:${index}`, fields ? fields.length * 0.1 : 2, this.profile(platform, index));
      case 'performance':
        return this.charge(`${url.pathname}:${index}`, 2, {
          uniqueId: handleOf(index),
          reelsPerformanceRecent: { views: { median: index * 300, avg: index * 350 }, engagement: { avgEngagementRate: 0.01 * (index % 9) } },
        });
      case 'contact': {
        const emails = index % 2 === 0 ? [`hello+${index}@example.com`] : [];
        return this.charge(`${url.pathname}:${index}`, emails.length ? 15 : 0, { uniqueId: handleOf(index), emails });
      }
      default:
        return this.fail(404, 'NOT_FOUND', 'Unknown endpoint');
    }
  };

  private profile(platform: Platform, i: number): Record<string, unknown> {
    const followers = platform === 'youtube' ? { totalSubscribers: i * 1000 } : { totalFollowers: i * 1000 };
    return {
      uniqueId: handleOf(i),
      ...(platform === 'youtube' ? { channelId: channelIdOf(i) } : {}),
      displayName: `Creator ${i}`,
      ...followers,
      country: i % 2 ? 'USA' : 'GBR',
      mainLanguage: 'eng',
      bio: i % 3 === 0 ? `Skincare routines and SPF reviews, account ${i}` : `Daily vlogs, account ${i}`,
    };
  }

  private indexOf(platform: Platform, source: Record<string, unknown>): number | null {
    const id = String(source.channelId ?? source.uniqueId ?? '');
    const match = platform === 'youtube' && id.startsWith('UC') ? /^UC[a]*(\d+)$/.exec(id) : /^@?creator_(\d+)$/.exec(id);
    const index = match ? Number(match[1]) : NaN;
    return Number.isInteger(index) && index >= 1 && index <= this.size ? index : null;
  }

  private search(platform: Platform, body: Record<string, unknown>): Response {
    const filters = (body.filters ?? []) as Array<{ filterName: string; op: string; value: unknown }>;
    let indexes = Array.from({ length: this.size }, (_, k) => k + 1);
    for (const f of filters) {
      if (f.filterName === 'uniqueId' && f.op === 'in') {
        const wanted = new Set((f.value as string[]).map((v) => v.replace(/^@/, '')));
        indexes = indexes.filter((i) => wanted.has(handleOf(i)));
      } else if (/^total(Followers|Subscribers)$/.test(f.filterName)) {
        const n = Number(f.value);
        indexes = indexes.filter((i) => (f.op === '>' ? i * 1000 > n : f.op === '<' ? i * 1000 < n : i * 1000 === n));
      }
    }
    indexes.sort((a, b) => (body.desc === false ? a - b : b - a));
    const offset = Number(body.offset ?? 0);
    const pageSize = Number(body.pageSize ?? 20);
    const page = indexes.slice(offset, offset + pageSize);
    const creatorList = page.map((i) => {
      const p = this.profile(platform, i);
      const { bio, country, mainLanguage, ...top } = p;
      return body.fields ? { ...top, profile: { bio, country, mainLanguage } } : top;
    });
    const hasNextPage = offset + pageSize < indexes.length;
    return this.envelope({ creatorList, totalResults: indexes.length, hasNextPage, nextOffset: hasNextPage ? offset + pageSize : null }, 1);
  }

  private charge(key: string, credits: number, data: Record<string, unknown>): Response {
    if (credits > 0 && this.creditsAvailable < credits) return this.fail(402, 'INSUFFICIENT_CREDITS', 'Out of credits');
    if (credits > 0) this.paid.set(key, (this.paid.get(key) ?? 0) + 1);
    return this.envelope(data, credits);
  }

  private ok(data: unknown, credits: number): Response {
    return this.envelope(data, credits);
  }

  private envelope(data: unknown, credits: number): Response {
    this.creditsAvailable -= credits;
    this.creditsUsed += credits;
    return Response.json({
      data,
      creditsUsed: credits,
      creditsAvailable: this.creditsAvailable,
      traceId: `trace-${this.calls.length}`,
      timestamp: 1_700_000_000_000,
      errorCode: '',
      errorDescription: '',
      success: true,
    });
  }

  private fail(status: number, code: string, description: string): Response {
    return Response.json(
      { data: null, creditsUsed: 0, creditsAvailable: this.creditsAvailable, traceId: 'trace-x', timestamp: 0, errorCode: code, errorDescription: description, success: false },
      { status },
    );
  }

  /** Calls made to one endpoint, such as "/instagram/profile". */
  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }
}
