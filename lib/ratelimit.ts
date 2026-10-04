// Sliding windows held in memory. They reset when the server instance is recycled, which is
// acceptable for a demo: the aim is to stop one visitor, or a script, running up search and LLM spend.
const WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();
let global: number[] = [];

function perIpLimit(): number {
  const n = Number(process.env.RATE_LIMIT_PER_10_MIN);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function globalLimit(): number {
  const n = Number(process.env.GLOBAL_LIMIT_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/** One unit of paid work (a check or a judge call) by one visitor. Per-IP window plus a global hourly cap. */
export function takeRateLimit(ip: string): { ok: boolean; retry_after_s: number } {
  const now = Date.now();
  global = global.filter((t) => now - t < HOUR_MS);
  if (global.length >= globalLimit()) return { ok: false, retry_after_s: Math.ceil((HOUR_MS - (now - global[0])) / 1000) };
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= perIpLimit()) {
    hits.set(ip, recent);
    return { ok: false, retry_after_s: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(ip, recent);
  global.push(now);
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
  }
  return { ok: true, retry_after_s: 0 };
}
