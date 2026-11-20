import { AsyncLocalStorage } from 'node:async_hooks';

/** One reply the gateway got from CreatorDB while a tool was running. */
export interface CapturedReply {
  replyId: number;
  method: string;
  path: string;
  status: number;
  /** The parsed reply, when CreatorDB sent JSON. */
  envelope: ApiEnvelope | unknown[] | null;
  creditsUsed: number;
  /** True when the reply came from this pull's saved copy and cost nothing. */
  reused: boolean;
}

/** The shape CreatorDB wraps every reply in. */
export interface ApiEnvelope {
  data?: unknown;
  success?: boolean;
  creditsUsed?: number;
  creditsAvailable?: number;
  errorCode?: string;
  errorDescription?: string;
  [key: string]: unknown;
}

/**
 * Who a CreatorDB call is for. The official tool code knows nothing about workspaces, so the
 * gateway reads this from the surrounding async context when a request reaches it.
 */
export interface CallContext {
  workspaceId: string;
  apiKey: string;
  /** Quick lookups go ahead of whole-list pulls. */
  priority: 'lookup' | 'pull';
  /** Set while a whole-list pull runs, so retries reuse saved replies and credits add up. */
  pullId?: number;
  capture: CapturedReply[];
  /** Set by the gateway when CreatorDB says the account is out of credits. */
  outOfCredits?: boolean;
}

export const callContext = new AsyncLocalStorage<CallContext>();

export function isEnvelope(value: unknown): value is ApiEnvelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
