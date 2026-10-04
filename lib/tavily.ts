import { ProviderError, Throttle, sleep, type SearchOutcome, type SearchParams, type SearchProvider } from "./search";

const throttle = new Throttle(5, 200);
const CREDIT_USD = 0.008;

interface TavilyResponse {
  results: { title?: string; url: string; content?: string; published_date?: string }[];
  response_time?: number;
}

/** Turns Keenable-style relative deltas ("1y", "30d") into the YYYY-MM-DD Tavily expects. */
function toDate(value: string, now: Date): string {
  const m = value.match(/^(\d+)(min|h|d|mo|y)$/);
  if (!m) return value.slice(0, 10);
  const n = Number(m[1]);
  const d = new Date(now);
  if (m[2] === "min") d.setUTCMinutes(d.getUTCMinutes() - n);
  else if (m[2] === "h") d.setUTCHours(d.getUTCHours() - n);
  else if (m[2] === "d") d.setUTCDate(d.getUTCDate() - n);
  else if (m[2] === "mo") d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Tavily as the comparison provider. The same query, result count and site filter are sent.
 * Keenable "realtime" is compared with Tavily "basic" (1 credit), and "pro" with "advanced" (2 credits).
 */
export const tavily: SearchProvider = {
  id: "tavily",
  label: "Tavily",
  price_usd_per_request: CREDIT_USD,
  price_basis: "$0.008 per credit pay-as-you-go list price (basic search 1 credit, advanced 2), tavily.com/pricing",

  async search(params: SearchParams): Promise<SearchOutcome> {
    const key = process.env.COMPARE_API_KEY;
    if (!key) throw new ProviderError("COMPARE_API_KEY is not set", 401);
    const depth = params.mode === "pro" ? "advanced" : "basic";
    const body: Record<string, unknown> = { query: params.query, search_depth: depth, max_results: params.max_results };
    if (params.site) body.include_domains = [params.site];
    if (params.published_after) body.start_date = toDate(params.published_after, new Date());

    for (let attempt = 1; ; attempt++) {
      const result = await throttle.run(async () => {
        const started = performance.now();
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
          cache: "no-store",
        });
        if (!res.ok) return { ok: false as const, status: res.status, message: (await res.text().catch(() => "")).slice(0, 200) };
        const data = (await res.json()) as TavilyResponse;
        return { ok: true as const, data, latency_ms: Math.round(performance.now() - started) };
      });
      if (result.ok) {
        return {
          latency_ms: result.latency_ms,
          attempts: attempt,
          cost_usd: (depth === "advanced" ? 2 : 1) * CREDIT_USD,
          hits: (result.data.results ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.url,
            description: "",
            snippet: (r.content ?? "").slice(0, params.snippet_max_length),
            published_at: r.published_date ?? null,
            acquired_at: null,
          })),
        };
      }
      if ((result.status !== 429 && result.status < 500) || attempt >= 3) throw new ProviderError(result.message || `HTTP ${result.status}`, result.status);
      await sleep(400 * attempt);
    }
  },
};
