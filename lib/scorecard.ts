import type { JudgeResult } from "./judge";
import type { Comparison, ProviderTotals } from "./types";

/**
 * The headline comparison: one content score from the blind judge, plus speed and cost scores
 * computed from what was measured, combined with fixed weights. Everything here is arithmetic
 * on numbers the page already shows, so the verdict can be checked by hand.
 */
export const WEIGHTS = { content: 0.5, speed: 0.25, cost: 0.25 } as const;
/** Judge sub-scores weighted in the compliance priority order. */
const CONTENT_WEIGHTS = { official_record: 3, relevance: 2, source_authority: 2, noise: 1 } as const;
/** Speed: 10 at 200 ms or faster, 1 at 3 s or slower, log-linear between; scored on p50 and p95 and averaged. */
const FAST_MS = 200;
const SLOW_MS = 3000;

export interface ProviderScore {
  content: number | null;
  speed: number;
  cost: number;
  total: number | null;
}

export interface Scorecard {
  primary: ProviderScore;
  other: ProviderScore;
  winner: "primary" | "other" | "tie" | null;
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => Math.max(1, Math.min(10, n));

function speedScore(ms: number): number {
  if (ms <= 0) return 1;
  return clamp(10 - (9 * Math.log(ms / FAST_MS)) / Math.log(SLOW_MS / FAST_MS));
}

export function contentScore(scores: JudgeResult["scores"][string] | undefined): number | null {
  if (!scores) return null;
  const sum = Object.entries(CONTENT_WEIGHTS).reduce((acc, [k, w]) => acc + w * (scores[k as keyof typeof CONTENT_WEIGHTS] ?? 0), 0);
  const total = Object.values(CONTENT_WEIGHTS).reduce((a, b) => a + b, 0);
  return round1(sum / total);
}

export function scorecard(comparison: Comparison, judgement: Pick<JudgeResult, "scores"> | null): Scorecard {
  const perRequest = (t: ProviderTotals) => (t.searches ? t.cost_usd / t.searches : 0);
  const cheapest = Math.min(perRequest(comparison.primary), perRequest(comparison.other)) || 1;
  const score = (t: ProviderTotals, judgeScores: JudgeResult["scores"][string] | undefined): ProviderScore => {
    const speed = round1((speedScore(t.latency_ms_p50) + speedScore(t.latency_ms_p95)) / 2);
    const cost = round1(clamp(perRequest(t) ? (10 * cheapest) / perRequest(t) : 10));
    const content = contentScore(judgeScores);
    const total = content === null ? null : round1(WEIGHTS.content * content + WEIGHTS.speed * speed + WEIGHTS.cost * cost);
    return { content, speed, cost, total };
  };
  const primary = score(comparison.primary, judgement?.scores.keenable);
  const other = score(comparison.other, judgement?.scores[comparison.provider]);
  const winner = primary.total === null || other.total === null ? null : Math.abs(primary.total - other.total) < 0.3 ? "tie" : primary.total > other.total ? "primary" : "other";
  return {
    primary,
    other,
    winner,
    note: `Content is the blind judge's four scores weighted ${CONTENT_WEIGHTS.official_record}:${CONTENT_WEIGHTS.relevance}:${CONTENT_WEIGHTS.source_authority}:${CONTENT_WEIGHTS.noise} (official record, relevance, authority, noise). Speed scores p50 and p95: 10 at ${FAST_MS} ms, 1 at ${SLOW_MS / 1000} s. Cost is 10 for the cheaper provider per request, scaled down for the other. Overall = ${WEIGHTS.content * 100}% content + ${WEIGHTS.speed * 100}% speed + ${WEIGHTS.cost * 100}% cost; within 0.3 is a tie.`,
  };
}
