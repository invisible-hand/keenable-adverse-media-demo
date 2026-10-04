import { compareProvider } from "@/lib/exa";
import { judgeAndScore, judgeModel } from "@/lib/judge";
import { llmConfigured } from "@/lib/llm";
import { takeRateLimit } from "@/lib/ratelimit";
import type { Comparison, HitSummary } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface JudgeBody {
  subject?: string;
  subject_type?: string;
  context?: string;
  queries?: { query_id: string; query: string; site?: string; primary: HitSummary[]; other: HitSummary[] }[];
  comparison?: Comparison;
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const hits = (list: unknown): HitSummary[] =>
  Array.isArray(list)
    ? list.slice(0, 10).map((h) => ({ title: clean(h?.title, 300), url: clean(h?.url, 1000), published_at: typeof h?.published_at === "string" ? h.published_at : null, snippet: clean(h?.snippet, 400) }))
    : [];

/** Judges the lists the page already holds; nothing about the check is stored server-side. */
export async function POST(request: Request) {
  const model = judgeModel();
  const compare = compareProvider();
  if (!model || !compare || !llmConfigured()) return Response.json({ error: "The judge is not configured" }, { status: 503 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!takeRateLimit(`judge:${ip}`).ok) return Response.json({ error: "Rate limit reached" }, { status: 429 });

  if (Number(request.headers.get("content-length") ?? 0) > 400_000) return Response.json({ error: "Request too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as JudgeBody | null;
  if (!body?.queries?.length || !body.comparison) return Response.json({ error: "Nothing to judge yet" }, { status: 400 });
  const queries = body.queries.slice(0, 30).map((q) => ({
    query_id: clean(q.query_id, 10),
    query: clean(q.query, 300),
    site: q.site ? clean(q.site, 100) : undefined,
    primary: hits(q.primary).map((h) => ({ ...h, description: "", snippet: h.snippet ?? "", acquired_at: null })),
    other: hits(q.other).map((h) => ({ ...h, description: "", snippet: h.snippet ?? "", acquired_at: null })),
  }));
  try {
    const judgement = await judgeAndScore(
      {
        subject: clean(body.subject, 120),
        subject_type: body.subject_type === "individual" ? "individual" : "organization",
        identifiers: clean(body.context, 300),
        queries,
        comparison: body.comparison,
        primary_label: "Keenable",
        other_label: compare.label,
      },
      model,
    );
    return Response.json({ judgement });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Judge failed" }, { status: 500 });
  }
}
