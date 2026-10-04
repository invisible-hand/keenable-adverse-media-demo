import { ProviderError, Throttle, sleep, type FetchOutcome, type SearchOutcome, type SearchParams, type SearchProvider } from "./search";

const BASE = "https://api.keenable.ai";
const MAX_ATTEMPTS = 4;

// Keenable allows 10 requests/second per organisation. Five in flight with starts
// at least 125 ms apart keeps searches and fetches together at 8/second or less.
const throttle = new Throttle(5, 125);

interface KeenableSearchResponse {
  query: string;
  mode: string;
  results: {
    title: string;
    url: string;
    description: string;
    snippet?: string;
    published_at?: string;
    acquired_at?: string;
  }[];
}

interface KeenableFetchResponse {
  url: string;
  title?: string;
  description?: string;
  author?: string;
  content: string;
  /** The live API returns Unix seconds here; the OpenAPI file says ISO 8601. Both are handled. */
  published_at?: number | string;
}

function apiKey(): string {
  const key = process.env.KEENABLE_API_KEY;
  if (!key) throw new ProviderError("KEENABLE_API_KEY is not set", 401);
  return key;
}

/** One HTTP call with retries on 429 and 5xx. Returns the parsed body and the latency of the attempt that succeeded. */
async function call<T>(url: string, init: RequestInit, timeoutMs: number): Promise<{ body: T; latency_ms: number; attempts: number }> {
  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await throttle.run(async () => {
      const started = performance.now();
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as T;
          return { ok: true as const, body, latency_ms: Math.round(performance.now() - started) };
        }
        const detail = await res.text().catch(() => "");
        let message = detail.slice(0, 300);
        try {
          const parsed = JSON.parse(detail) as { error?: string; message?: string };
          message = [parsed.error, parsed.message].filter(Boolean).join(": ") || message;
        } catch {}
        const retryAfter = Number(res.headers.get("retry-after"));
        return { ok: false as const, status: res.status, message, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 };
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        return { ok: false as const, status: timedOut ? 408 : 0, message: timedOut ? `timed out after ${timeoutMs} ms` : String(err), retryAfterMs: 0 };
      }
    });
    if (result.ok) return { body: result.body, latency_ms: result.latency_ms, attempts: attempt };
    lastError = new ProviderError(result.message || `HTTP ${result.status}`, result.status);
    const retryable = result.status === 429 || result.status >= 500 || result.status === 0;
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    const backoff = Math.max(result.retryAfterMs, 300 * 2 ** (attempt - 1)) + Math.random() * 200;
    await sleep(Math.min(backoff, 5000));
  }
  throw lastError ?? new ProviderError("request failed", 0);
}

export const keenable: SearchProvider = {
  id: "keenable",
  label: "Keenable",
  price_usd_per_request: 0.004,
  // keenable.ai pricing, Agent Builder pay-as-you-go tier, read 2026-10-01. The REST
  // response carries no per-call usage data, so cost is requests x list price.
  price_basis: "$4 per 1K requests list price",

  async search(params: SearchParams): Promise<SearchOutcome> {
    const body: Record<string, string | number> = {
      query: params.query,
      mode: params.mode,
      max_results: params.max_results,
      snippet_max_length: params.snippet_max_length,
    };
    if (params.site) body.site = params.site;
    if (params.published_after) body.published_after = params.published_after;
    if (params.query_time) body.query_time = params.query_time;

    const { body: data, latency_ms, attempts } = await call<KeenableSearchResponse>(
      `${BASE}/v1/search`,
      { method: "POST", headers: { "X-API-Key": apiKey(), "Content-Type": "application/json" }, body: JSON.stringify(body) },
      15000,
    );
    return {
      latency_ms,
      attempts,
      hits: (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url,
        description: r.description ?? "",
        snippet: r.snippet ?? "",
        published_at: r.published_at ?? null,
        acquired_at: r.acquired_at ?? null,
      })),
    };
  },

  async fetchPage(url: string, opts: { max_chars: number; live: boolean }): Promise<FetchOutcome> {
    const qs = new URLSearchParams({ url, max_chars: String(opts.max_chars) });
    if (opts.live) qs.set("live", "true");
    const { body: data, latency_ms } = await call<KeenableFetchResponse>(
      `${BASE}/v1/fetch?${qs}`,
      { method: "GET", headers: { "X-API-Key": apiKey() } },
      opts.live ? 12000 : 8000,
    );
    const published =
      typeof data.published_at === "number"
        ? new Date(data.published_at * 1000).toISOString()
        : typeof data.published_at === "string"
          ? data.published_at
          : null;
    return { url: data.url ?? url, title: data.title ?? "", content: data.content ?? "", published_at: published, latency_ms, live: opts.live };
  },
};
