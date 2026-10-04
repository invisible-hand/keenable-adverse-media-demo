import { ProviderError, Throttle, sleep, type SearchOutcome, type SearchParams, type SearchProvider } from "./search";
import { tavily } from "./tavily";

const throttle = new Throttle(5, 200);

interface ExaResponse {
  results: { title?: string; url: string; publishedDate?: string; highlights?: string[] }[];
  costDollars?: { total?: number };
}

/** Turns Keenable-style relative deltas ("1y", "30d") into the ISO timestamp Exa expects. */
function toIsoDate(value: string, now: Date): string {
  const m = value.match(/^(\d+)(min|h|d|mo|y)$/);
  if (!m) return new Date(value).toISOString();
  const n = Number(m[1]);
  const d = new Date(now);
  if (m[2] === "min") d.setUTCMinutes(d.getUTCMinutes() - n);
  else if (m[2] === "h") d.setUTCHours(d.getUTCHours() - n);
  else if (m[2] === "d") d.setUTCDate(d.getUTCDate() - n);
  else if (m[2] === "mo") d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString();
}

/**
 * Exa as the comparison provider. The same query, result count and site filter are sent;
 * highlights are requested so both providers return a text excerpt per result.
 * Keenable "pro" is compared with Exa "auto", and "realtime" with Exa "fast".
 */
export const exa: SearchProvider = {
  id: "exa",
  label: "Exa",
  price_usd_per_request: 0.004,
  price_basis: "cost reported by the Exa API per call (costDollars); list price from $4 per 1K requests plus contents, exa.ai/pricing",

  async search(params: SearchParams): Promise<SearchOutcome> {
    const key = process.env.COMPARE_API_KEY;
    if (!key) throw new ProviderError("COMPARE_API_KEY is not set", 401);
    const body: Record<string, unknown> = {
      query: params.query,
      type: params.mode === "realtime" ? "fast" : "auto",
      numResults: params.max_results,
      contents: { highlights: true },
    };
    if (params.site) body.includeDomains = [params.site];
    if (params.published_after) body.startPublishedDate = toIsoDate(params.published_after, new Date());

    for (let attempt = 1; ; attempt++) {
      const result = await throttle.run(async () => {
        const started = performance.now();
        const res = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: { "x-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
          cache: "no-store",
        });
        if (!res.ok) return { ok: false as const, status: res.status, message: (await res.text().catch(() => "")).slice(0, 200) };
        const data = (await res.json()) as ExaResponse;
        return { ok: true as const, data, latency_ms: Math.round(performance.now() - started) };
      });
      if (result.ok) {
        return {
          latency_ms: result.latency_ms,
          attempts: attempt,
          cost_usd: result.data.costDollars?.total,
          hits: (result.data.results ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.url,
            description: "",
            snippet: (r.highlights ?? []).join(" … ").slice(0, params.snippet_max_length),
            published_at: r.publishedDate ?? null,
            acquired_at: null,
          })),
        };
      }
      if ((result.status !== 429 && result.status < 500) || attempt >= 3) throw new ProviderError(result.message || `HTTP ${result.status}`, result.status);
      await sleep(400 * attempt);
    }
  },
};

export function compareProvider(): SearchProvider | null {
  if (!process.env.COMPARE_API_KEY) return null;
  if (process.env.COMPARE_PROVIDER === "tavily") return tavily;
  if (process.env.COMPARE_PROVIDER === "exa") return exa;
  return null;
}
