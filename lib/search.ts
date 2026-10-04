import type { SearchMode } from "./types";

export interface SearchParams {
  query: string;
  mode: SearchMode;
  site?: string;
  published_after?: string;
  /** Point-in-time search: pages acquired after this instant are excluded. */
  query_time?: string;
  max_results: number;
  snippet_max_length: number;
}

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  snippet: string;
  published_at: string | null;
  acquired_at: string | null;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Round trip of the successful provider call only, measured server-side. */
  latency_ms: number;
  attempts: number;
  /** Cost of this call when the provider reports it. */
  cost_usd?: number;
}

export interface FetchOutcome {
  url: string;
  title: string;
  content: string;
  published_at: string | null;
  latency_ms: number;
  live: boolean;
}

export interface SearchProvider {
  id: string;
  label: string;
  /** Published list price per request, and where that number comes from. */
  price_usd_per_request: number;
  price_basis: string;
  search(params: SearchParams): Promise<SearchOutcome>;
  fetchPage?(url: string, opts: { max_chars: number; live: boolean }): Promise<FetchOutcome>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Caps concurrent calls and spaces request starts, shared by every check running in this
 * process, so searches plus fetches stay under the provider's per-second limit.
 */
export class Throttle {
  private active = 0;
  private nextStart = 0;
  private queue: (() => void)[] = [];

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      const now = Date.now();
      const startAt = Math.max(now, this.nextStart);
      this.nextStart = startAt + this.minIntervalMs;
      if (startAt > now) await sleep(startAt - now);
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
