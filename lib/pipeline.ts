import { randomUUID } from "node:crypto";
import { keenable } from "./keenable";
import { judgeAndScore, judgeModel } from "./judge";
import { extractReport, llmConfigured, llmModel, planVariants, LlmError, type ExtractionInput } from "./llm";
import type { SearchHit } from "./search";
import { scanPartialJson } from "./partial";
import { deterministicPlan, maxQueries } from "./planner";
import type { SearchProvider } from "./search";
import { displayUrl, domainOf, languageOf, normalizeForMatch, rankByAuthority, normalizeUrl, percentile, quoteAppearsIn, reliabilityByDomain } from "./text";
import type { JudgeResult } from "./judge";
import {
  ExtractionSchema,
  LIMITATIONS,
  type AuditEntry,
  type CheckEvent,
  type CheckRequest,
  type Comparison,
  type ComparisonRow,
  type Extraction,
  type FetchEntry,
  type Finding,
  type PlannedQuery,
  type Report,
  type Source,
  type SubjectType,
  type ValidationReport,
} from "./types";

const RESULTS_PER_QUERY = 8;
const SNIPPET_CHARS = 500;
const FETCH_CHARS = 8000;
const MAX_SOURCES_FOR_LLM = 60;
const PLANNER_WAIT_MS = 15000;

function maxFetches(): number {
  const n = Number(process.env.MAX_FETCHES_PER_CHECK);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 12) : 10;
}

interface SourceRecord {
  source_id: string;
  key: string;
  url: string;
  title: string;
  description: string;
  snippets: string[];
  published_at: string | null;
  retrieved_at: string;
  query_ids: string[];
  best_rank: number;
  content: string | null;
}

const ACTION_LABELS: Record<Extraction["overall"]["recommended_action"], string> = {
  clear: "clear",
  escalate_to_edd: "escalate to enhanced due diligence",
  refer_for_sar_consideration: "refer to the responsible officer for SAR consideration",
  insufficient_information: "insufficient information to assess",
};

export class CheckError extends Error {
  constructor(
    message: string,
    public stage: string,
  ) {
    super(message);
  }
}

/** Runs one check end to end, emitting progress events as it goes, and returns the validated report. */
export async function runCheck(req: CheckRequest, emit: (event: CheckEvent) => void, provider: SearchProvider = keenable, compare: SearchProvider | null = null, runJudge = false): Promise<Report> {
  const wallStart = performance.now();
  const check_id = randomUUID();
  // One timestamp pins every query to the same index state, so the audit log can be re-run against it later.
  const as_of = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const cap = maxQueries();

  emit({ type: "check_started", check_id, as_of, mode: req.mode, provider: provider.id, max_queries: cap });

  const audit: AuditEntry[] = [];
  const sources = new Map<string, SourceRecord>();
  let queryCounter = 0;
  const compareRows: ComparisonRow[] = [];
  const compareRuns: Promise<void>[] = [];
  const hitsByQuery = new Map<string, { mine: SearchHit[]; other: SearchHit[] }>();

  const buildComparison = (): Comparison | undefined => {
    if (!compare) return undefined;
    const okRows = compareRows.filter((r) => !r.error);
    const both = okRows.map((r) => ({ row: r, mine: audit.find((a) => a.query_id === r.query_id)! })).filter((x) => x.mine && !x.mine.error);
    const otherResults = both.reduce((n, x) => n + x.row.result_count, 0);
    return {
      provider: compare.id,
      label: compare.label,
      mode_note: modeNote(req.mode, compare.id),
      primary: {
        searches: both.length,
        latency_ms_p50: percentile(both.map((x) => x.mine.latency_ms), 50),
        latency_ms_p95: percentile(both.map((x) => x.mine.latency_ms), 95),
        results: both.reduce((n, x) => n + x.mine.result_count, 0),
        cost_usd: round4(both.length * provider.price_usd_per_request),
        price_basis: provider.price_basis,
      },
      other: {
        searches: both.length,
        latency_ms_p50: percentile(both.map((x) => x.row.latency_ms), 50),
        latency_ms_p95: percentile(both.map((x) => x.row.latency_ms), 95),
        results: otherResults,
        cost_usd: round4(both.reduce((n, x) => n + x.row.cost_usd, 0)),
        price_basis: compare.price_basis,
      },
      url_overlap_pct: otherResults ? Math.round((both.reduce((n, x) => n + x.row.overlap, 0) / otherResults) * 100) : 0,
      rows: [...compareRows].sort((a, b) => idNumber(a.query_id) - idNumber(b.query_id)),
    };
  };

  const runQuery = async (planned: PlannedQuery): Promise<void> => {
    const query_id = `q${++queryCounter}`;
    // Site-restricted lookups run in realtime mode: measured on 14 such queries it returned the expected official page at the
    // same rank as pro, in under 200 ms, where a cold pro query took up to 3 s.
    const mode = planned.site ? "realtime" : req.mode;
    const params: Record<string, string | number> = { mode, max_results: RESULTS_PER_QUERY, query_time: as_of };
    if (planned.site) params.site = planned.site;
    if (planned.published_after) params.published_after = planned.published_after;
    const started_at = new Date().toISOString();
    const entry: AuditEntry = {
      query_id,
      category: planned.category,
      query: planned.query,
      params,
      note: planned.note,
      started_at,
      latency_ms: 0,
      attempts: 0,
      result_count: 0,
      result_urls: [],
    };
    audit.push(entry);
    emit({ type: "query_started", query_id, category: planned.category, query: planned.query, params, note: planned.note, started_at });
    const searchParams = {
      query: planned.query,
      mode,
      site: planned.site,
      published_after: planned.published_after,
      max_results: RESULTS_PER_QUERY,
      snippet_max_length: SNIPPET_CHARS,
    };
    let finishPrimary!: () => void;
    const primaryDone = new Promise<void>((resolve) => (finishPrimary = resolve));
    if (compare) {
      // The same query goes to the comparison provider. Its results are measured, not used in the report.
      compareRuns.push(
        compare
          .search(searchParams)
          .then((raw) => ({ ...raw, hits: rankByAuthority(raw.hits) }))
          .then(async (other) => {
            await primaryDone;
            const mine = new Set(entry.result_urls.map(normalizeUrl));
            hitsByQuery.set(query_id, { mine: hitsByQuery.get(query_id)?.mine ?? [], other: other.hits });
            const row: ComparisonRow = {
              query_id,
              hits: other.hits.map((h) => ({ title: h.title, url: displayUrl(h.url), published_at: h.published_at, snippet: (h.snippet || h.description).slice(0, 240) })),
              latency_ms: other.latency_ms,
              result_count: other.hits.length,
              overlap: other.hits.filter((h) => mine.has(normalizeUrl(h.url))).length,
              cost_usd: other.cost_usd ?? compare.price_usd_per_request,
            };
            compareRows.push(row);
            emit({ type: "compare_finished", provider: compare.id, row });
          })
          .catch((err) => {
            const row: ComparisonRow = { query_id, hits: [], latency_ms: 0, result_count: 0, overlap: 0, cost_usd: 0, error: err instanceof Error ? err.message : String(err) };
            compareRows.push(row);
            emit({ type: "compare_finished", provider: compare.id, row });
          }),
      );
    }
    try {
      const raw = await provider.search({ ...searchParams, query_time: as_of });
      // Both providers' lists are ordered by publisher tier before anyone, including the judge, sees them.
      const outcome = { ...raw, hits: rankByAuthority(raw.hits) };
      entry.latency_ms = outcome.latency_ms;
      entry.attempts = outcome.attempts;
      entry.result_count = outcome.hits.length;
      hitsByQuery.set(query_id, { mine: outcome.hits, other: hitsByQuery.get(query_id)?.other ?? [] });
      const retrieved_at = new Date().toISOString();
      outcome.hits.forEach((hit, rank) => {
        entry.result_urls.push(displayUrl(hit.url));
        const key = normalizeUrl(hit.url);
        let rec = sources.get(key);
        if (!rec) {
          rec = {
            source_id: `s${sources.size + 1}`,
            key,
            url: displayUrl(hit.url),
            title: hit.title,
            description: hit.description,
            snippets: [],
            published_at: hit.published_at,
            retrieved_at,
            query_ids: [],
            best_rank: rank,
            content: null,
          };
          sources.set(key, rec);
        }
        if (!rec.query_ids.includes(query_id)) rec.query_ids.push(query_id);
        rec.best_rank = Math.min(rec.best_rank, rank);
        if (hit.snippet && !rec.snippets.includes(hit.snippet)) rec.snippets.push(hit.snippet);
        rec.published_at ??= hit.published_at;
      });
      emit({ type: "query_finished", query_id, latency_ms: outcome.latency_ms, result_count: outcome.hits.length, attempts: outcome.attempts, hits: outcome.hits.map((h) => ({ title: h.title, url: displayUrl(h.url), published_at: h.published_at, snippet: (h.snippet || h.description).slice(0, 240) })) });
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      emit({ type: "query_finished", query_id, latency_ms: 0, result_count: 0, attempts: 0, hits: [], error: entry.error });
    } finally {
      finishPrimary();
    }
  };

  // The fixed queries start at once; the LLM works out spelling variants in parallel and those queries join when ready.
  emit({ type: "phase", phase: "searching" });
  let resolvedType: SubjectType = req.subject_type ?? guessType(req.name);
  const base = deterministicPlan(req).slice(0, cap);
  const variantSlots = cap - base.length;
  let plannerTokens = { input: 0, output: 0 };
  const variantsPromise: Promise<PlannedQuery[]> =
    llmConfigured()
      ? Promise.race([
          planVariants(req, variantSlots).then((res) => {
            plannerTokens = { input: res.input_tokens, output: res.output_tokens };
            if (!req.subject_type) resolvedType = res.output.subject_type;
            return res.output.queries.slice(0, Math.max(0, variantSlots)).map((q) => ({ category: q.category, query: q.query, note: q.note, site: q.site ?? undefined }));
          }),
          new Promise<PlannedQuery[]>((resolve) => setTimeout(() => resolve([]), PLANNER_WAIT_MS)),
        ]).catch(() => [])
      : Promise.resolve([]);

  const baseRuns = Promise.all(base.map(runQuery));
  const seenQueries = new Set(base.map((q) => q.query.toLowerCase()));
  const variants = (await variantsPromise).filter((q) => q.query.trim() && !seenQueries.has(q.query.toLowerCase()));
  await Promise.all([baseRuns, ...variants.map(runQuery)]);

  const succeeded = audit.filter((a) => !a.error);
  if (succeeded.length === 0) {
    throw new CheckError(`Every search failed. First error: ${audit[0]?.error ?? "unknown"}`, "search");
  }

  // The judge runs here only for the test script; the page asks for it through /api/judge on demand.
  let judgement: JudgeResult | undefined;
  const judgeName = judgeModel();
  const judgePromise: Promise<void> =
    compare && judgeName && runJudge && llmConfigured()
      ? Promise.all(compareRuns)
          .then(async () => {
            const built = buildComparison();
            if (!built) return;
            judgement = await judgeAndScore(
              {
                subject: req.name,
                subject_type: resolvedType,
                identifiers: Object.values(req.identifiers).filter(Boolean).join("; "),
                queries: audit
                  .filter((a) => !a.error && hitsByQuery.has(a.query_id))
                  .map((a) => ({ query_id: a.query_id, query: a.query, site: a.params.site as string | undefined, primary: hitsByQuery.get(a.query_id)!.mine, other: hitsByQuery.get(a.query_id)!.other })),
                comparison: built,
                primary_label: provider.label,
                other_label: compare.label,
              },
              judgeName,
            );
            emit({ type: "judge", judgement });
          })
          .catch((err) => emit({ type: "judge_failed", message: err instanceof Error ? err.message : String(err) }))
      : Promise.resolve();

  // Full text for the pages most likely to settle identity and stage.
  emit({ type: "phase", phase: "fetching" });
  const ranked = rankSources([...sources.values()], req.name);
  const fetchLog: FetchEntry[] = [];
  let fetchCalls = 0;
  if (provider.fetchPage) {
    const targets = pickFetchTargets(ranked, maxFetches());
    await Promise.all(
      targets.map(async (rec) => {
        const started_at = new Date().toISOString();
        emit({ type: "fetch_started", source_id: rec.source_id, url: rec.url });
        const attempt = async (live: boolean) => {
          fetchCalls++;
          const page = await provider.fetchPage!(rec.url, { max_chars: FETCH_CHARS, live });
          rec.content = page.content;
          rec.published_at ??= page.published_at;
          fetchLog.push({ url: rec.url, source_id: rec.source_id, started_at, latency_ms: page.latency_ms, live, chars: page.content.length });
          emit({ type: "fetch_finished", source_id: rec.source_id, url: rec.url, latency_ms: page.latency_ms, chars: page.content.length, live });
        };
        try {
          await attempt(false);
        } catch (first) {
          try {
            // Not in the index: an official page is worth one live fetch, anything else is left as a snippet.
            if (reliabilityByDomain(rec.url) !== "primary_official") throw first;
            await attempt(true);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fetchLog.push({ url: rec.url, source_id: rec.source_id, started_at, latency_ms: 0, live: false, chars: 0, error: message });
            emit({ type: "fetch_finished", source_id: rec.source_id, url: rec.url, latency_ms: 0, chars: 0, live: false, error: message });
          }
        }
      }),
    );
  }

  // Extraction sees only what was retrieved, each item tagged with its source id.
  emit({ type: "phase", phase: "analysing", detail: llmModel() });
  const forLlm = ranked.slice(0, MAX_SOURCES_FOR_LLM).sort((a, b) => idNumber(a.source_id) - idNumber(b.source_id));
  const sourceText = new Map<string, string>();
  for (const rec of forLlm) sourceText.set(rec.source_id, textOf(rec));
  const sentIds = new Set(forLlm.map((r) => r.source_id));

  const input: ExtractionInput = {
    req: { ...req, subject_type: resolvedType },
    as_of,
    queries: audit.map((a) => ({
      query_id: a.query_id,
      category: a.category,
      query: a.query,
      site: a.params.site as string | undefined,
      published_after: a.params.published_after as string | undefined,
      result_count: a.result_count,
      source_ids: a.result_urls.map((u) => sources.get(normalizeUrl(u))?.source_id).filter((id): id is string => Boolean(id && sentIds.has(id))),
      error: a.error,
    })),
    sources: forLlm.map((rec) => ({
      source_id: rec.source_id,
      url: rec.url,
      title: rec.title,
      published_at: rec.published_at,
      fetched: rec.content !== null,
      text: sourceText.get(rec.source_id) ?? "",
    })),
  };

  // Nothing reaches the report unless it points at a retrieved source and its quote is in that source's text.
  const normalized = new Map<string, string>();
  const normalizedText = (id: string) => {
    if (!normalized.has(id)) normalized.set(id, normalizeForMatch(sourceText.get(id) ?? ""));
    return normalized.get(id)!;
  };
  type RawFinding = Extraction["findings"][number];
  const checkFinding = (f: RawFinding): { ok: true; source_ids: string[] } | { ok: false; reason: string } => {
    const validIds = [...new Set(f.source_ids)].filter((id) => sentIds.has(id));
    if (validIds.length === 0) return { ok: false, reason: "No cited source is in the retrieved set" };
    if (!validIds.some((id) => quoteAppearsIn(f.quoted_support, normalizedText(id)))) return { ok: false, reason: "Quoted support was not found verbatim in the cited sources" };
    return { ok: true, source_ids: validIds };
  };
  const toSource = (rec: SourceRecord, cited: boolean): Source => ({
    source_id: rec.source_id,
    url: rec.url,
    title: rec.title,
    publisher: domainOf(rec.url),
    published_at: rec.published_at,
    retrieved_at: rec.retrieved_at,
    query_id: rec.query_ids[0],
    query_ids: rec.query_ids,
    reliability: reliabilityByDomain(rec.url) ?? "unverified",
    language: languageOf(`${rec.title} ${rec.snippets[0] ?? rec.description}`),
    fetched: rec.content !== null,
    cited,
  });
  const recById = new Map([...sources.values()].map((r) => [r.source_id, r]));

  // Findings are checked and shown one by one while the model is still writing the rest.
  let identitySent = false;
  let overallSent = false;
  let findingsSeen = 0;
  let findingsShown = 0;
  const onText = (snapshot: string) => {
    const partial = scanPartialJson(snapshot);
    if (!identitySent && partial.values.resolved_identity) {
      const parsed = ExtractionSchema.shape.resolved_identity.safeParse(partial.values.resolved_identity);
      if (parsed.success) {
        identitySent = true;
        emit({ type: "partial_identity", resolved_identity: parsed.data });
      }
    }
    if (!overallSent && partial.values.overall) {
      const parsed = ExtractionSchema.shape.overall.safeParse(partial.values.overall);
      if (parsed.success) {
        overallSent = true;
        emit({ type: "partial_overall", overall: parsed.data });
      }
    }
    const list = partial.items.findings ?? [];
    for (; findingsSeen < list.length; findingsSeen++) {
      const parsed = ExtractionSchema.shape.findings.element.safeParse(list[findingsSeen]);
      if (!parsed.success) continue;
      const verdict = checkFinding(parsed.data);
      if (!verdict.ok) continue;
      emit({
        type: "partial_finding",
        finding: { ...parsed.data, finding_id: `f${++findingsShown}`, source_ids: verdict.source_ids },
        sources: verdict.source_ids.map((id) => toSource(recById.get(id)!, true)),
      });
    }
  };

  let extraction: Awaited<ReturnType<typeof extractReport>>;
  try {
    extraction = await extractReport(input, onText);
  } catch (err) {
    throw new CheckError(err instanceof LlmError ? err.message : `Extraction failed: ${err instanceof Error ? err.message : String(err)}`, "extraction");
  }

  emit({ type: "phase", phase: "validating" });
  const out = extraction.output;
  const validation: ValidationReport = { findings_returned: out.findings.length, findings_kept: 0, dropped_findings: [], removed_sentences: [], uncited_claims: 0 };
  const findings: Finding[] = [];
  for (const f of out.findings) {
    const verdict = checkFinding(f);
    if (!verdict.ok) {
      validation.dropped_findings.push({ summary: f.summary, reason: verdict.reason });
      continue;
    }
    findings.push({ ...f, finding_id: `f${findings.length + 1}`, source_ids: verdict.source_ids });
  }
  validation.findings_kept = findings.length;

  const queryIds = new Set(audit.map((a) => a.query_id));
  const cited = new Set<string>(findings.flatMap((f) => f.source_ids));
  const bodyParagraphs: string[] = [];
  for (const paragraph of out.narrative_paragraphs) {
    const kept: string[] = [];
    for (const sentence of paragraph.sentences) {
      const text = sentence.text.replace(/\s*\[[sq]\d+\]/g, "").trim();
      const cites = [...new Set(sentence.citations.map((c) => c.replace(/[\[\]\s]/g, "")))].filter((c) => sentIds.has(c) || queryIds.has(c));
      if (!text) continue;
      if (cites.length === 0) {
        validation.removed_sentences.push({ sentence: text, reason: "No valid source or query citation" });
        continue;
      }
      cites.filter((c) => c.startsWith("s")).forEach((c) => cited.add(c));
      kept.push(`${text} ${cites.map((c) => `[${c}]`).join("")}`);
    }
    if (kept.length) bodyParagraphs.push(kept.join(" "));
  }

  const open_items = [...out.overall.open_items];
  if (validation.dropped_findings.length > 0) {
    open_items.push(
      `${validation.dropped_findings.length} finding(s) returned by the model failed the citation check and were removed; the rating was set before removal and should be re-reviewed.`,
    );
  }

  const reportSources: Source[] = [...sources.values()].map((rec) => toSource(rec, cited.has(rec.source_id)));

  await Promise.all(compareRuns);
  const comparison = buildComparison();

  const free_text = !req.preset_id;
  const latencies = succeeded.map((a) => a.latency_ms);
  const fetchOk = fetchLog.filter((f) => !f.error);
  const searchCalls = audit.reduce((n, a) => n + Math.max(a.attempts, 1), 0);
  const total_wall_ms = Math.round(performance.now() - wallStart);
  const date = as_of.slice(0, 10);
  const time = as_of.slice(11, 16);

  const intro =
    `This memo records an open-web adverse-media check on ${req.name} (${resolvedType}), run on ${date} at ${time} UTC. ` +
    `${audit.length} searches were run through ${provider.label} in ${req.mode} mode, pinned to the index as of that time; ` +
    `${sources.size} distinct sources were returned and ${fetchOk.length} pages were retrieved in full.`;
  const conclusion =
    `On the basis of the sources reviewed, the ${free_text ? "preliminary " : ""}risk rating is ${out.overall.risk_rating} and the recommended action is to ${
      out.overall.recommended_action === "insufficient_information" ? "treat the check as incomplete (insufficient information to assess)" : ACTION_LABELS[out.overall.recommended_action]
    }. ${out.overall.rating_rationale} This is a recommendation for human review and is not a determination about the subject.`;

  const report: Report = {
    check_id,
    generated_at: new Date().toISOString(),
    free_text,
    delivery: "live",
    subject: {
      input_name: req.name,
      subject_type: resolvedType,
      user_supplied_identifiers: req.identifiers,
      resolved_identity: out.resolved_identity,
    },
    search_scope: {
      categories_covered: [...new Set(audit.map((a) => a.category))],
      languages: [...new Set(["en", ...reportSources.filter((s) => s.cited && s.language).map((s) => s.language)])],
      date_range: "No lower date bound, except the recent-news query (last 12 months)",
      as_of,
      provider: provider.id,
      mode: req.mode,
    },
    audit_log: audit,
    fetch_log: fetchLog,
    sources: reportSources,
    findings,
    overall: {
      ...out.overall,
      open_items,
      rating_label: free_text ? "Preliminary, requires human review" : "Recommended rating, requires human sign-off",
    },
    narrative: [intro, ...bodyParagraphs, conclusion].join("\n\n"),
    validation,
    comparison,
    judgement,
    metrics: {
      searches: searchCalls,
      fetches: fetchCalls,
      search_latency_ms_p50: percentile(latencies, 50),
      search_latency_ms_p95: percentile(latencies, 95),
      fetch_latency_ms_p50: percentile(
        fetchOk.map((f) => f.latency_ms),
        50,
      ),
      total_wall_ms,
      // The planner call runs alongside the searches, so only extraction counts towards analysis time.
      llm_ms: extraction.ms,
      llm_input_tokens: extraction.input_tokens + plannerTokens.input,
      llm_output_tokens: extraction.output_tokens + plannerTokens.output,
      search_cost_usd: round4(searchCalls * provider.price_usd_per_request),
      fetch_cost_usd: round4(fetchCalls * provider.price_usd_per_request),
      price_basis: provider.price_basis,
    },
    llm: { model: llmModel(), served_by: extraction.served_by },
    limitations: LIMITATIONS,
  };
  // The report goes out as soon as it is ready; the stream then stays open until the judge has spoken.
  emit({ type: "report", report });
  await judgePromise;
  report.judgement = judgement;
  return report;
}

function modeNote(mode: "pro" | "realtime", other: string): string {
  const pair = other === "tavily" ? { pro: "advanced", realtime: "basic" } : { pro: "auto", realtime: "fast" };
  return mode === "realtime" ? `Keenable realtime vs ${other} ${pair.realtime}` : `Keenable pro (realtime for site-restricted queries) vs ${other} ${pair.pro}`;
}

/** Fallback when the planner does not answer: company words mean a business, two or three capitalised words a person. */
function guessType(name: string): SubjectType {
  if (/\b(inc|llc|ltd|limited|corp|corporation|company|co|plc|gmbh|sa|ag|bank|group|holdings|partners|capital|foundation|academy|labs|technologies|cash|exchange)\b\.?/i.test(name)) return "organization";
  const words = name.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z\u00C0-\u024F]/.test(w)) ? "individual" : "organization";
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function idNumber(id: string): number {
  return Number(id.slice(1));
}

function textOf(rec: SourceRecord): string {
  const parts = [rec.title, rec.description, ...rec.snippets].map((p) => p.trim()).filter(Boolean);
  const head = parts.filter((p, i) => parts.indexOf(p) === i).join("\n");
  return rec.content ? `${head}\n\n[Full page text]\n${rec.content}` : head;
}

/** Orders sources by how likely they are to matter: official and established publishers, hits returned by several queries, top ranks, and pages that name the subject. */
function rankSources(all: SourceRecord[], name: string): SourceRecord[] {
  const tokens = name
    .toLowerCase()
    .split(/[\s,./()-]+/)
    .filter((t) => t.length >= 2);
  const phrase = name.toLowerCase().replace(/\s+/g, " ").trim();
  const now = Date.now();
  const score = (rec: SourceRecord): number => {
    const reliability = reliabilityByDomain(rec.url);
    let s = reliability === "primary_official" ? 3 : reliability === "established_media" ? 2 : 0;
    s += (rec.query_ids.length - 1) * 0.75;
    s += Math.max(0, 1.5 - rec.best_rank * 0.5);
    // A page that never names the subject is usually a site-filter near miss, so naming the subject outweighs the publisher.
    const haystack = `${rec.title} ${rec.description} ${rec.snippets.join(" ")}`.toLowerCase().replace(/\s+/g, " ");
    if (haystack.includes(phrase)) s += 3;
    else if (tokens.length && tokens.every((t) => haystack.includes(t))) s += 1;
    // Recent pages are the ones that show the current stage of a matter.
    const ageYears = rec.published_at ? (now - Date.parse(rec.published_at)) / (365.25 * 24 * 3600 * 1000) : NaN;
    if (ageYears <= 2) s += 1;
    else if (ageYears <= 5) s += 0.5;
    if (/\.pdf($|\?)|\/download($|\?)|\/dl($|\?)/i.test(rec.url)) s -= 2;
    return s;
  };
  return all
    .map((rec) => ({ rec, s: score(rec) }))
    .sort((a, b) => b.s - a.s || idNumber(a.rec.source_id) - idNumber(b.rec.source_id))
    .map((x) => x.rec);
}

function pickFetchTargets(ranked: SourceRecord[], limit: number): SourceRecord[] {
  const perDomain = new Map<string, number>();
  const picked: SourceRecord[] = [];
  for (const rec of ranked) {
    if (picked.length >= limit) break;
    if (/\.pdf($|\?)|\/download($|\?)|\/dl($|\?)/i.test(rec.url)) continue;
    const domain = domainOf(rec.url);
    const used = perDomain.get(domain) ?? 0;
    if (used >= 3) continue;
    perDomain.set(domain, used + 1);
    picked.push(rec);
  }
  return picked;
}
