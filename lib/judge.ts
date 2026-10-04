import { z } from "zod";
import { structuredCall, type LlmResult } from "./llm";
import { scorecard, type Scorecard } from "./scorecard";
import type { SearchHit } from "./search";
import type { Comparison } from "./types";

export const JudgementSchema = z.object({
  overall_winner: z.enum(["A", "B", "tie"]),
  summary: z.string(),
  scores: z.object({
    A: z.object({ official_record: z.number(), relevance: z.number(), source_authority: z.number(), noise: z.number() }),
    B: z.object({ official_record: z.number(), relevance: z.number(), source_authority: z.number(), noise: z.number() }),
  }),
  per_query: z.array(z.object({ query_id: z.string(), better: z.enum(["A", "B", "tie"]), reason: z.string() })),
});
export type Judgement = z.infer<typeof JudgementSchema>;

/** The judgement with A/B mapped back to provider ids. */
export interface JudgeResult {
  model: string;
  /** Which provider was shown as "A"; the judge never saw provider names. */
  label_a: string;
  label_b: string;
  winner: string;
  /** Content-only reasoning, written blind. */
  summary: string;
  /** Verdict over content, speed and cost, written after the measurements were revealed. */
  overall_summary: string;
  sections: { verdict: string; content: string; speed: string; cost: string };
  scorecard: Scorecard;
  scores: Record<string, { official_record: number; relevance: number; source_authority: number; noise: number }>;
  per_query: { query_id: string; better: string; reason: string }[];
  ms: number;
}

export function judgeModel(): string | null {
  const m = process.env.JUDGE_MODEL ?? "claude-sonnet-5-5";
  return m === "off" ? null : m;
}

const JUDGE_SYSTEM = `You are a senior compliance analyst evaluating two web search providers for adverse-media screening. Both were sent the same queries about the same subject and each returned up to eight results per query, already sorted so that official sources come first. You see the two result lists for every query, labelled Provider A and Provider B. You do not know which provider is which, and you must not guess; judge only what is in front of you.

Judge as an analyst who has to write a defensible file would, in this order of importance:
1. official_record: did the results surface the primary record, meaning regulator, court, prosecutor or other government pages about the subject's own matters, where such pages exist? The official release is the document the file is built on. Finding it matters more than anything else, and a provider that returns it when the other does not wins that query outright.
2. relevance: how much of each list is about this subject, as opposed to namesakes, generic pages about the topic, or pages that merely contain the words?
3. source_authority: how reliable are the publishers: official bodies and established news organisations versus aggregators, content farms, forums and social media? Note that a rewrite of an official release on a weak site is still evidence of the matter; it is the weaker source, not a wrong one.
4. noise: how much junk is there: duplicates, listing pages, irrelevant documents? Score noise so that a higher number is better (10 means no junk).

Scores are integers from 1 to 10. For each query decide which provider an analyst would rather have, applying the order above, and call it a tie when the lists are equivalent for the analyst's purpose. The overall verdict follows the same order: first compare official-record coverage across all queries, then relevance, then authority, then noise. Give concrete reasons that name titles or domains. Latency and cost are measured separately; ignore them. Refer to the two sides only as "Provider A" and "Provider B", written out in full each time, because the labels are replaced with the real names afterwards. The summary is three or four plain sentences for a compliance officer, starting with the verdict and the main reason.`;

export interface JudgeInput {
  subject: string;
  subject_type: string;
  identifiers: string;
  queries: { query_id: string; query: string; site?: string; a: SearchHit[]; b: SearchHit[] }[];
}

function list(hits: SearchHit[]): string {
  if (hits.length === 0) return "    (no results)";
  return hits.map((h, i) => `    ${i + 1}. ${h.title || "(untitled)"} | ${h.url}${h.published_at ? ` | ${h.published_at.slice(0, 10)}` : ""}\n       ${(h.snippet || h.description || "").replace(/\s+/g, " ").slice(0, 320)}`).join("\n");
}

export async function judgeResults(input: JudgeInput, model: string): Promise<LlmResult<Judgement>> {
  const user = [
    `Subject: ${input.subject} (${input.subject_type}). Identifiers supplied: ${input.identifiers || "none"}.`,
    ``,
    ...input.queries.flatMap((q) => [
      `=== ${q.query_id}: "${q.query}"${q.site ? ` (restricted to ${q.site})` : ""}`,
      `  A:`,
      list(q.a),
      `  B:`,
      list(q.b),
      ``,
    ]),
    `Judge every query listed, then give the overall verdict.`,
  ].join("\n");
  return structuredCall({ schema: JudgementSchema, system: JUDGE_SYSTEM, user, effort: "medium", max_tokens: 6000, timeout_ms: 150000, model });
}

const VERDICT_SYSTEM = `You are the same compliance analyst who has just judged two search providers' result lists blind, on content only. The provider names are now revealed, together with two measured facts for the same queries: latency and cost per request. Write the overall verdict a head of compliance would act on, weighing content, speed and cost together using the scorecard supplied, which fixes the weights: half content, a quarter speed, a quarter cost.

Write four short parts, each one or two plain sentences, and refer to the providers by name:
- verdict: who is ahead overall and by what scores, and in one clause what decided it.
- content: what the content gap was and why it matters for the file, naming the documents or domains that made the difference. Do not soften a content gap because the overall favours the other provider, and do not inflate it either.
- speed: the measured p50 and p95 for both, and what the gap means across a fan-out of ten queries, where latency compounds.
- cost: the measured cost per check for both and what the difference means per check and across a screening programme.`;

const VerdictSchema = z.object({ verdict: z.string(), content: z.string(), speed: z.string(), cost: z.string() });

export interface JudgeAndScoreInput {
  subject: string;
  subject_type: string;
  identifiers: string;
  queries: { query_id: string; query: string; site?: string; primary: SearchHit[]; other: SearchHit[] }[];
  comparison: Comparison;
  primary_label: string;
  other_label: string;
}

/** Blind content judgement, then the scorecard, then a verdict written with the measurements in view. */
export async function judgeAndScore(input: JudgeAndScoreInput, model: string): Promise<JudgeResult> {
  const started = performance.now();
  const swap = Math.random() < 0.5;
  const res = await judgeResults(
    {
      subject: input.subject,
      subject_type: input.subject_type,
      identifiers: input.identifiers,
      queries: input.queries.map((q) => ({ query_id: q.query_id, query: q.query, site: q.site, a: swap ? q.other : q.primary, b: swap ? q.primary : q.other })),
    },
    model,
  );
  const primaryId = input.comparison.provider === "keenable" ? "keenable" : "keenable";
  const otherId = input.comparison.provider;
  const idOf = (side: "A" | "B" | "tie") => (side === "tie" ? "tie" : (side === "A") !== swap ? primaryId : otherId);
  const label = (id: string) => (id === primaryId ? input.primary_label : input.other_label);
  const named = (text: string) => text.replace(/\bProvider A\b/g, label(idOf("A"))).replace(/\bProvider B\b/g, label(idOf("B")));
  const out = res.output;
  const scores = { [idOf("A")]: out.scores.A, [idOf("B")]: out.scores.B };
  const partial: JudgeResult = {
    model,
    label_a: idOf("A"),
    label_b: idOf("B"),
    winner: idOf(out.overall_winner),
    summary: named(out.summary),
    overall_summary: "",
    sections: { verdict: "", content: "", speed: "", cost: "" },
    scorecard: scorecard(input.comparison, { scores } as JudgeResult),
    scores,
    per_query: out.per_query.map((q) => ({ query_id: q.query_id, better: idOf(q.better), reason: named(q.reason) })),
    ms: 0,
  };
  const c = input.comparison;
  const sc = partial.scorecard;
  const fmt = (n: number | null) => (n === null ? "n/a" : String(n));
  const user = [
    `Subject: ${input.subject}.`,
    `Your blind content judgement: ${partial.summary}`,
    `Content scores (official record, relevance, authority, noise): ${input.primary_label} ${[scores[primaryId]?.official_record, scores[primaryId]?.relevance, scores[primaryId]?.source_authority, scores[primaryId]?.noise].join("/")}; ${input.other_label} ${[scores[otherId]?.official_record, scores[otherId]?.relevance, scores[otherId]?.source_authority, scores[otherId]?.noise].join("/")}.`,
    `Measured over the same ${c.primary.searches} queries: ${input.primary_label} latency p50 ${c.primary.latency_ms_p50} ms, p95 ${c.primary.latency_ms_p95} ms, ${c.primary.results} results, cost $${c.primary.cost_usd.toFixed(3)}; ${input.other_label} latency p50 ${c.other.latency_ms_p50} ms, p95 ${c.other.latency_ms_p95} ms, ${c.other.results} results, cost $${c.other.cost_usd.toFixed(3)}.`,
    `Scorecard (content / speed / cost / overall, out of 10): ${input.primary_label} ${fmt(sc.primary.content)} / ${sc.primary.speed} / ${sc.primary.cost} / ${fmt(sc.primary.total)}; ${input.other_label} ${fmt(sc.other.content)} / ${sc.other.speed} / ${sc.other.cost} / ${fmt(sc.other.total)}. ${sc.note}`,
    `Write the overall verdict.`,
  ].join("\n");
  const verdict = await structuredCall({ schema: VerdictSchema, system: VERDICT_SYSTEM, user, effort: "low", max_tokens: 1200, timeout_ms: 60000, model });
  partial.sections = verdict.output;
  partial.overall_summary = [verdict.output.verdict, verdict.output.content, verdict.output.speed, verdict.output.cost].join("\n\n");
  partial.ms = Math.round(performance.now() - started);
  return partial;
}
