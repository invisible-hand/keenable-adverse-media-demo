"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { JudgeResult } from "@/lib/judge";
import { scorecard } from "@/lib/scorecard";
import type { Preset } from "@/lib/presets";
import { FREE_TEXT_DISCLAIMER, type CheckEvent, type Comparison, type ComparisonRow, type Finding, type HitSummary, type Report, type Source, type SubjectType } from "@/lib/types";

const LIST_PRICE = 0.004;

const CATEGORY_LABELS: Record<string, string> = {
  news: "news",
  litigation: "litigation",
  sanctions_enforcement: "enforcement",
  company_website: "identity",
  reviews: "reviews",
  officers_associates: "associates",
  identity: "identity",
  alias_variant: "name variant",
  native_language: "native language",
};

const RISK_LABELS: Record<string, string> = {
  financial_crime: "Financial crime",
  fraud: "Fraud",
  bribery_corruption: "Bribery and corruption",
  sanctions: "Sanctions",
  terrorism_financing: "Terrorism financing",
  trafficking: "Human trafficking",
  narcotics: "Narcotics",
  organised_crime: "Organised crime",
  tax_crime: "Tax crime",
  cybercrime: "Cybercrime",
  market_abuse: "Market abuse",
  regulatory_enforcement: "Regulatory enforcement",
  other: "Other",
};

const STAGE_LABELS: Record<string, string> = {
  allegation: "Allegation",
  investigation: "Investigation",
  charged: "Charged",
  settled: "Settled",
  convicted: "Convicted",
  acquitted_or_dismissed: "Acquitted or dismissed",
  sanctioned: "Sanctioned",
  delisted: "Delisted",
  unknown: "Stage not stated",
};

const DISPOSITION_LABELS: Record<Finding["disposition"], string> = { true_match: "True match", false_positive: "False positive", inconclusive: "Inconclusive" };

const ACTION_LABELS: Record<string, string> = {
  clear: "Clear",
  escalate_to_edd: "Escalate to enhanced due diligence",
  refer_for_sar_consideration: "Refer for SAR consideration",
  insufficient_information: "Insufficient information to assess",
};

const RELIABILITY_LABELS: Record<Source["reliability"], string> = { primary_official: "official", established_media: "media", trade_or_local: "trade", unverified: "unverified" };

const PHASE_LABELS: Record<string, string> = {
  searching: "searching",
  fetching: "reading the strongest pages in full",
  analysing: "writing the assessment",
  validating: "checking every quote against its source",
};

interface QueryRow {
  query_id: string;
  category: string;
  query: string;
  site?: string;
  status: "running" | "done" | "error";
  latency_ms: number;
  hits: HitSummary[];
  error?: string;
}

interface RunState {
  status: "idle" | "running" | "done" | "error";
  label: string;
  subjectType: SubjectType;
  freeText: boolean;
  startedAt: number;
  endedAt: number;
  phase: string;
  queries: QueryRow[];
  fetchesDone: number;
  compareRows: ComparisonRow[];
  judgement: JudgeResult | null;
  judgeFailed: string;
  /** True from the start of a run until the judge answers or the stream closes. */
  judgePending: boolean;
  partialIdentity: Report["subject"]["resolved_identity"] | null;
  partialFindings: Finding[];
  partialSources: Source[];
  partialOverall: Omit<Report["overall"], "rating_label"> | null;
  report: Report | null;
  error: { stage: string; message: string } | null;
}

const IDLE: RunState = {
  status: "idle",
  label: "",
  subjectType: "organization",
  freeText: false,
  startedAt: 0,
  endedAt: 0,
  phase: "",
  queries: [],
  fetchesDone: 0,
  compareRows: [],
  judgement: null,
  judgeFailed: "",
  judgePending: false,
  partialIdentity: null,
  partialFindings: [],
  partialSources: [],
  partialOverall: null,
  report: null,
  error: null,
};

type Action =
  | { kind: "start"; label: string; subjectType: SubjectType; freeText: boolean; judge: boolean; at: number }
  | { kind: "event"; event: CheckEvent; at: number }
  | { kind: "fail"; message: string; at: number }
  | { kind: "closed" };

function reducer(state: RunState, action: Action): RunState {
  if (action.kind === "start") return { ...IDLE, status: "running", label: action.label, subjectType: action.subjectType, freeText: action.freeText, judgePending: action.judge, startedAt: action.at, phase: "searching" };
  if (action.kind === "closed") return { ...state, judgePending: false };
  if (action.kind === "fail") return { ...state, status: "error", endedAt: action.at, error: { stage: "network", message: action.message } };
  const e = action.event;
  switch (e.type) {
    case "phase":
      return { ...state, phase: e.phase };
    case "query_started":
      return { ...state, queries: [...state.queries, { query_id: e.query_id, category: e.category, query: e.query, site: e.params.site as string | undefined, status: "running", latency_ms: 0, hits: [] }] };
    case "query_finished":
      return { ...state, queries: state.queries.map((q) => (q.query_id === e.query_id ? { ...q, status: e.error ? "error" : "done", latency_ms: e.latency_ms, hits: e.hits, error: e.error } : q)) };
    case "compare_finished":
      return { ...state, compareRows: [...state.compareRows, e.row] };
    case "judge":
      return { ...state, judgement: e.judgement, judgePending: false };
    case "judge_failed":
      return { ...state, judgeFailed: e.message, judgePending: false };
    case "fetch_finished":
      return { ...state, fetchesDone: state.fetchesDone + 1 };
    case "partial_identity":
      return { ...state, partialIdentity: e.resolved_identity };
    case "partial_finding":
      return { ...state, partialFindings: [...state.partialFindings, e.finding], partialSources: [...state.partialSources, ...e.sources] };
    case "partial_overall":
      return { ...state, partialOverall: e.overall };
    case "report": {
      const r = e.report;
      const fromLog = r.delivery === "cached" || state.queries.length === 0;
      return {
        ...state,
        status: "done",
        endedAt: action.at,
        report: r,
        subjectType: r.subject.subject_type,
        judgement: r.judgement ?? state.judgement,
        queries: fromLog
          ? r.audit_log.map((a) => ({
              query_id: a.query_id,
              category: a.category,
              query: a.query,
              site: a.params.site as string | undefined,
              status: a.error ? ("error" as const) : ("done" as const),
              latency_ms: a.latency_ms,
              hits: a.result_urls.map((u) => ({ title: r.sources.find((s) => s.url === u)?.title ?? u, url: u, published_at: null })),
              error: a.error,
            }))
          : state.queries,
        compareRows: r.comparison?.rows ?? state.compareRows,
      };
    }
    case "error":
      return { ...state, status: "error", endedAt: action.at, error: { stage: e.stage, message: e.message } };
    default:
      return state;
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const fmtMs = (ms: number) => (!ms ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fmtUsd = (n: number) => `$${n.toFixed(3)}`;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const providerName = (id: string, compareLabel: string | null) => (id === "keenable" ? "Keenable" : id === "tie" ? "Tie" : (compareLabel ?? id));

export default function Console({ presets, llmModel, maxQueries, compareLabel }: { presets: Preset[]; llmModel: string; maxQueries: number; compareLabel: string | null }) {
  const [run, dispatch] = useReducer(reducer, IDLE);
  const [activePreset, setActivePreset] = useState("");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  /** Exactly what went to the server with the current free-text check, shown on the status line. */
  const [sentContext, setSentContext] = useState("");
  const [now, setNow] = useState(0);
  const [showHow, setShowHow] = useState(false);
  const [judgeState, setJudgeState] = useState<{ status: "idle" | "running" | "done" | "error"; result: JudgeResult | null; error: string; open: boolean }>({ status: "idle", result: null, error: "", open: false });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!judgeState.open && !showHow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setJudgeState((j) => ({ ...j, open: false }));
      setShowHow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [judgeState.open, showHow]);

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [run.status]);

  async function start(body: Record<string, unknown>, label: string, type: SubjectType, freeText: boolean) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setNow(Date.now());
    setJudgeState({ status: "idle", result: null, error: "", open: false });
    dispatch({ kind: "start", label, subjectType: type, freeText, judge: Boolean(compareLabel), at: Date.now() });
    try {
      const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        dispatch({ kind: "fail", message: data.error ?? `Request failed (${res.status})`, at: Date.now() });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)) as CheckEvent;
            if (event.type === "report" || event.type === "error") finished = true;
            dispatch({ kind: "event", event, at: Date.now() });
          }
        }
      }
      if (!finished) dispatch({ kind: "fail", message: "The connection closed before the report arrived.", at: Date.now() });
      dispatch({ kind: "closed" });
    } catch (err) {
      if (controller.signal.aborted) return;
      dispatch({ kind: "fail", message: err instanceof Error ? err.message : "Network error", at: Date.now() });
    }
  }

  function runPreset(p: Preset) {
    setActivePreset(p.id);
    setName("");
    setContext("");
    setShowContext(false);
    start({ preset_id: p.id }, p.name, p.subject_type, false);
  }

  function runFreeText(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setActivePreset("");
    const sent = showContext ? context.trim() : "";
    setSentContext(sent);
    start({ name, context: sent }, name.trim(), "organization", true);
  }

  const report = run.report;
  const preset = presets.find((p) => p.id === activePreset);
  const running = run.status === "running";
  const clock = running ? now : run.endedAt;
  const elapsed = run.startedAt ? Math.max(0, clock - run.startedAt) : 0;

  const meters = useMemo(() => {
    if (report) {
      const m = report.metrics;
      return { searches: m.searches, p50: m.search_latency_ms_p50, p95: m.search_latency_ms_p95, cost: m.search_cost_usd + m.fetch_cost_usd, wall: m.total_wall_ms };
    }
    const done = run.queries.filter((q) => q.status === "done");
    const latencies = done.map((q) => q.latency_ms);
    return { searches: done.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), cost: (done.length + run.fetchesDone) * LIST_PRICE, wall: elapsed };
  }, [report, run.queries, run.fetchesDone, elapsed]);

  const compareByQuery = useMemo(() => new Map(run.compareRows.map((r) => [r.query_id, r])), [run.compareRows]);
  const judgeByQuery = useMemo(() => new Map(((judgeState.result ?? run.judgement)?.per_query ?? []).map((q) => [q.query_id, q])), [judgeState.result, run.judgement]);

  const sideBySide = useMemo((): Comparison | null => {
    if (report?.comparison) return report.comparison;
    if (!compareLabel || run.compareRows.length === 0) return null;
    const both = run.compareRows
      .filter((r) => !r.error)
      .map((row) => ({ row, mine: run.queries.find((q) => q.query_id === row.query_id) }))
      .filter((x): x is { row: ComparisonRow; mine: QueryRow } => x.mine?.status === "done");
    const otherResults = both.reduce((n, x) => n + x.row.result_count, 0);
    return {
      provider: compareLabel.toLowerCase(),
      label: compareLabel,
      mode_note: "",
      primary: { searches: both.length, latency_ms_p50: percentile(both.map((x) => x.mine.latency_ms), 50), latency_ms_p95: percentile(both.map((x) => x.mine.latency_ms), 95), results: both.reduce((n, x) => n + x.mine.hits.length, 0), cost_usd: both.length * LIST_PRICE, price_basis: "" },
      other: { searches: both.length, latency_ms_p50: percentile(both.map((x) => x.row.latency_ms), 50), latency_ms_p95: percentile(both.map((x) => x.row.latency_ms), 95), results: otherResults, cost_usd: both.reduce((n, x) => n + x.row.cost_usd, 0), price_basis: "" },
      url_overlap_pct: otherResults ? Math.round((both.reduce((n, x) => n + x.row.overlap, 0) / otherResults) * 100) : 0,
      rows: run.compareRows,
    };
  }, [report, compareLabel, run.compareRows, run.queries]);

  async function askJudge() {
    if (!sideBySide || judgeState.status === "running") return;
    if (judgeState.status === "done") {
      setJudgeState((j) => ({ ...j, open: true }));
      return;
    }
    setJudgeState({ status: "running", result: null, error: "", open: true });
    const byId = new Map(run.compareRows.map((r) => [r.query_id, r]));
    const queries = run.queries
      .filter((q) => q.status === "done" && byId.get(q.query_id) && !byId.get(q.query_id)!.error)
      .map((q) => ({ query_id: q.query_id, query: q.query, site: q.site, primary: q.hits, other: byId.get(q.query_id)!.hits }));
    try {
      const res = await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: run.label, subject_type: run.subjectType, context: report?.subject.user_supplied_identifiers.other ?? "", queries, comparison: sideBySide }),
      });
      const data = (await res.json().catch(() => ({}))) as { judgement?: JudgeResult; error?: string };
      if (!res.ok || !data.judgement) {
        setJudgeState({ status: "error", result: null, error: data.error ?? `Judge failed (${res.status})`, open: true });
        return;
      }
      setJudgeState({ status: "done", result: data.judgement, error: "", open: true });
    } catch (err) {
      setJudgeState({ status: "error", result: null, error: err instanceof Error ? err.message : "Network error", open: true });
    }
  }

  function downloadJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify({ ...report, judgement: report.judgement ?? judgeState.result ?? run.judgement ?? undefined }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `adverse-media-check-${report.check_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const people = presets.filter((p) => p.subject_type === "individual");
  const companies = presets.filter((p) => p.subject_type === "organization");
  const answered = run.queries.filter((q) => q.status !== "running").length;
  const phaseText = running ? (run.phase === "searching" ? `searching · ${answered}/${run.queries.length || maxQueries} back` : (PHASE_LABELS[run.phase] ?? "working")) : run.status === "done" ? (run.judgePending ? "file complete · judge still reading" : "complete") : "stopped";
  const judge = judgeState.result ?? run.judgement;
  const card = judge?.scorecard ?? (sideBySide && judge ? scorecard(sideBySide, judge) : null);
  const cardWinner = card?.winner === "primary" ? "keenable" : card?.winner === "other" ? (compareLabel ?? "other").toLowerCase() : card?.winner === "tie" ? "tie" : null;

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          <span className="wordmark-name">Keenable</span>
          <span className="wordmark-rule" />
          <span className="wordmark-sub">Adverse media check</span>
        </div>
        <span className="masthead-note">
          search · Keenable &nbsp;|&nbsp; assessment · {llmModel} &nbsp;|&nbsp; judge · {judge?.model ?? "claude-sonnet-5-5"}
          <button className="textbtn how-btn" onClick={() => setShowHow(true)}>
            how it works
          </button>
        </span>
      </header>

      <section className="intake">
        <form className="intake-form" onSubmit={runFreeText}>
          <input className="name-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of a person or company" maxLength={120} aria-label="Subject name" />
          <button
            type="button"
            className="textbtn"
            onClick={() => {
              if (showContext) setContext("");
              setShowContext((v) => !v);
            }}
            aria-expanded={showContext}
          >
            {showContext ? "no context" : "add context"}
          </button>
          <button className="go" disabled={name.trim().length < 2}>
            Check
          </button>
        </form>
        {showContext && <input className="context-field" value={context} onChange={(e) => setContext(e.target.value)} placeholder="Anything you know: country, employer, role, age, former names" maxLength={240} aria-label="Context" />}
        <div className="presets">
          {[
            ["People", people],
            ["Companies", companies],
          ].map(([title, list]) => (
            <div className="preset-line" key={title as string}>
              <span className="preset-key">{title as string}</span>
              {(list as Preset[]).map((p) => (
                <button key={p.id} className={`preset ${p.expected_outcome} ${activePreset === p.id ? "active" : ""}`} onClick={() => runPreset(p)} title={p.record}>
                  {p.label}
                </button>
              ))}
            </div>
          ))}
          <p className="preset-legend">
            <span className="dot adverse" /> adverse record on file &nbsp; <span className="dot clean" /> expected to come back clear
          </p>
        </div>
      </section>

      {run.status !== "idle" && (
        <main className="split">
          <section className="console" aria-label="Search log">
            <div className="console-head">
              <span className={`lamp ${running ? "on" : ""}`} />
              <span className="console-title">{run.label}</span>
              <span className="console-phase">{phaseText}</span>
              <span className="console-clock">{fmtS(elapsed)}</span>
            </div>
            {!preset && run.freeText && (
              <p className="console-record">{sentContext ? `context sent · ${sentContext}` : "no context sent · name only"}</p>
            )}
            {preset && (
              <p className="console-record">
                on file · {preset.record}
                {preset.expected_source && (
                  <>
                    {" "}
                    <a href={preset.expected_source} target="_blank" rel="noreferrer">
                      source ↗
                    </a>
                  </>
                )}
              </p>
            )}

            <div className="gauges">
              <Gauge label="searches" value={String(meters.searches)} />
              <Gauge label="p50" value={fmtMs(meters.p50)} />
              <Gauge label="p95" value={fmtMs(meters.p95)} />
              <Gauge label="search + fetch" value={meters.searches ? fmtUsd(meters.cost) : "—"} />
              <Gauge label="elapsed" value={meters.wall ? fmtS(meters.wall) : "—"} />
            </div>

            {compareLabel && (
              <div className="versus">
                <div className="versus-row versus-head">
                  <span />
                  <span>Keenable</span>
                  <span>{compareLabel}</span>
                </div>
                <div className="versus-row">
                  <span>latency p50 / p95</span>
                  <span>{sideBySide ? `${fmtMs(sideBySide.primary.latency_ms_p50)} / ${fmtMs(sideBySide.primary.latency_ms_p95)}` : "—"}</span>
                  <span>{sideBySide ? `${fmtMs(sideBySide.other.latency_ms_p50)} / ${fmtMs(sideBySide.other.latency_ms_p95)}` : "—"}</span>
                </div>
                <div className="versus-row">
                  <span>results · cost</span>
                  <span>{sideBySide ? `${sideBySide.primary.results} · ${fmtUsd(sideBySide.primary.cost_usd)}` : "—"}</span>
                  <span>{sideBySide ? `${sideBySide.other.results} · ${fmtUsd(sideBySide.other.cost_usd)}` : "—"}</span>
                </div>
                <div className="judge-cta">
                  <button className="judge-btn" onClick={askJudge} disabled={!report || !sideBySide || judgeState.status === "running"}>
                    {judgeState.status === "running" ? "Judge is reading…" : judgeState.status === "done" ? "Show the judge's verdict" : "Ask a blind judge"}
                  </button>
                  {judge && cardWinner && (
                    <span className={`judge-inline ${cardWinner === "keenable" ? "keenable" : ""}`}>
                      {cardWinner === "tie" ? "tie" : `${providerName(cardWinner, compareLabel)} ahead, ${card?.primary.total} to ${card?.other.total}`}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="log">
              <div className="log-head">
                <span>query</span>
                <span>Keenable</span>
                <span>{compareLabel ?? ""}</span>
              </div>
              {run.queries.map((q) => {
                const other = compareByQuery.get(q.query_id);
                const verdict = judgeByQuery.get(q.query_id);
                return (
                  <div key={q.query_id} className="log-row">
                    <div className="log-q">
                      <span className="log-id">
                        {q.query_id} · {CATEGORY_LABELS[q.category] ?? q.category}
                        {q.site ? ` · ${q.site}` : ""}
                      </span>
                      <span className="log-text">{q.query}</span>
                      {verdict && (
                        <span className={`log-verdict ${verdict.better}`} title={verdict.reason}>
                          judge · {providerName(verdict.better, compareLabel).toLowerCase()}
                        </span>
                      )}
                    </div>
                    <Hits status={q.status} latency={q.latency_ms} hits={q.hits} error={q.error} />
                    {compareLabel && (other ? <Hits status={other.error ? "error" : "done"} latency={other.latency_ms} hits={other.hits} error={other.error} /> : <Hits status="running" latency={0} hits={[]} />)}
                  </div>
                );
              })}
            </div>
            {sideBySide && report && (
              <p className="console-foot">
                {sideBySide.url_overlap_pct}% of {sideBySide.label}&apos;s URLs also came back from Keenable for the same query · {sideBySide.mode_note} · latency measured server-side around each call · both asked for 8 results
              </p>
            )}
            {run.status === "error" && run.error && (
              <p className="console-error">
                stopped at {run.error.stage}: {run.error.message}
              </p>
            )}
          </section>

          <section className="dossier" aria-label="Report">
            <Dossier
              report={report}
              identity={report?.subject.resolved_identity ?? run.partialIdentity}
              findings={report?.findings ?? run.partialFindings}
              sources={report?.sources ?? run.partialSources}
              overall={report?.overall ?? (run.partialOverall ? { ...run.partialOverall, rating_label: run.freeText ? "Preliminary, requires human review" : "Recommended rating, requires human sign-off" } : null)}
              label={run.label}
              subjectType={run.subjectType}
              freeText={run.freeText}
              running={running}
              phase={run.phase}
              onDownload={downloadJson}
            />
          </section>
        </main>
      )}

      {showHow && (
        <div className="modal-wrap" onClick={() => setShowHow(false)}>
          <div className="modal how" role="dialog" aria-label="How it works" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">How it works</span>
                <h2 className="modal-verdict">An adverse-media check, run by an agent on Keenable search</h2>
              </div>
              <button className="textbtn" onClick={() => setShowHow(false)}>
                close
              </button>
            </div>
            <div className="how-body">
              <p>
                Type a name or pick one of the cases. The agent does what a compliance analyst does when a new customer or merchant is onboarded: searches the open web for crime, fraud,
                sanctions, enforcement and litigation about that person or company, decides which hits are really about them, and writes the file a reviewer would sign.
              </p>
              <ol>
                <li>
                  <b>Plan.</b> Up to {maxQueries} queries: adverse news, enforcement and regulator sites (DOJ, Treasury, FinCEN, CFPB, and the subject&apos;s home regulator), recent news, identity, plus name
                  variants and native-script spellings suggested by the model.
                </li>
                <li>
                  <b>Search.</b> Every query goes to Keenable, with the timing of each call shown as it returns. The same queries go to {compareLabel ?? "a second provider"} so the two can be
                  compared on the same work.
                </li>
                <li>
                  <b>Read.</b> The ten most useful pages are fetched in full: official releases first.
                </li>
                <li>
                  <b>Write.</b> {llmModel} resolves who the subject is, lists each matter with its stage and a verbatim quote, closes namesakes as false positives, and recommends a rating. It sees only
                  what was retrieved.
                </li>
                <li>
                  <b>Check.</b> Every finding is dropped unless its quote is found word for word in the cited source. Every query, URL and timing is in the downloadable record.
                </li>
              </ol>
              <p>
                <b>The side by side.</b> Latency and cost are measured on the server around each provider call. The blind judge (Sonnet 5.5) scores the two result lists on content without knowing
                which provider is which, then sees the measured speed and cost and writes an overall verdict: half content, a quarter speed, a quarter cost.
              </p>
              <p className="how-note">
                <b>This is a simplified picture.</b> A real BSA/AML programme is far more involved: adverse media is one input among many, alongside identity verification, beneficial-ownership
                checks, sanctions and PEP list screening, risk scoring, transaction monitoring, enhanced due diligence, case management, SAR decisions and a documented, audited process behind
                each of them. This demo shows one step, the open-web search and the analyst&apos;s write-up, and how much faster and cheaper that step gets with the right search layer.
              </p>
              <p className="how-note">
                It is not a sanctions list screen and makes no determination about anyone; a person decides. Names on the red line have a conviction, penalty or designation in an official
                release; the green line are expected to come back clear. Free-text checks are not stored.
              </p>
            </div>
          </div>
        </div>
      )}

      {judgeState.open && (
        <div className="modal-wrap" onClick={() => setJudgeState((j) => ({ ...j, open: false }))}>
          <div className="modal" role="dialog" aria-label="Blind judge" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">Blind judge · {judge?.model ?? "claude-sonnet-5-5"} · {run.label}</span>
                {judge && card && cardWinner ? (
                  <h2 className={`modal-verdict ${cardWinner === "keenable" ? "keenable" : ""}`}>{cardWinner === "tie" ? "Tie" : `${providerName(cardWinner, compareLabel)} ahead, ${card.primary.total} to ${card.other.total}`}</h2>
                ) : (
                  <h2 className="modal-verdict dim">{judgeState.status === "error" ? "The judge could not answer" : "Reading both result lists, blind…"}</h2>
                )}
              </div>
              <button className="textbtn" onClick={() => setJudgeState((j) => ({ ...j, open: false }))}>
                close
              </button>
            </div>
            {judgeState.status === "running" && (
              <p className="modal-wait">
                <span className="lamp on small" /> Content is judged first without provider names, latency or cost. Then the measurements are revealed for the overall verdict. About 15 to 25 seconds.
              </p>
            )}
            {judgeState.status === "error" && <p className="modal-error">{judgeState.error}</p>}
            {judge && card && compareLabel && (
              <>
                <div className="modal-scores">
                  <div className="mscore mscore-head">
                    <span />
                    <span>Keenable</span>
                    <span>{compareLabel}</span>
                  </div>
                  {(["content", "speed", "cost", "total"] as const).map((k) => (
                    <div key={k} className={`mscore ${k === "total" ? "mscore-total" : ""}`}>
                      <span className="mscore-label">{k === "content" ? "Content, judged blind" : k === "total" ? "Overall" : k === "speed" ? "Speed, measured" : "Cost, measured"}</span>
                      <span className="mbar">
                        <span className="mtrack">
                          <i style={{ width: `${(card.primary[k] ?? 0) * 10}%` }} className="k" />
                        </span>
                        <b>{card.primary[k] ?? "–"}</b>
                      </span>
                      <span className="mbar">
                        <span className="mtrack">
                          <i style={{ width: `${(card.other[k] ?? 0) * 10}%` }} className="t" />
                        </span>
                        <b>{card.other[k] ?? "–"}</b>
                      </span>
                    </div>
                  ))}
                </div>
                {judge.sections?.verdict ? (
                  <dl className="modal-sections">
                    {(["verdict", "content", "speed", "cost"] as const).map((k) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{judge.sections[k]}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="modal-summary">{judge.overall_summary || judge.summary}</p>
                )}
                <details className="modal-detail">
                  <summary>
                    Content judgement, written blind: {judge.winner === "tie" ? "tie" : `${providerName(judge.winner, compareLabel)} preferred`} · official record {judge.scores.keenable?.official_record ?? "–"} vs{" "}
                    {judge.scores[sideBySide?.provider ?? compareLabel.toLowerCase()]?.official_record ?? "–"} · relevance {judge.scores.keenable?.relevance ?? "–"} vs {judge.scores[sideBySide?.provider ?? compareLabel.toLowerCase()]?.relevance ?? "–"} · authority{" "}
                    {judge.scores.keenable?.source_authority ?? "–"} vs {judge.scores[sideBySide?.provider ?? compareLabel.toLowerCase()]?.source_authority ?? "–"} · noise {judge.scores.keenable?.noise ?? "–"} vs{" "}
                    {judge.scores[sideBySide?.provider ?? compareLabel.toLowerCase()]?.noise ?? "–"}
                  </summary>
                  <p>{judge.summary}</p>
                  <ol className="modal-queries">
                    {judge.per_query.map((q) => {
                      const row = run.queries.find((x) => x.query_id === q.query_id);
                      return (
                        <li key={q.query_id}>
                          <span className={`mq-call ${q.better}`}>{providerName(q.better, compareLabel)}</span>
                          <span className="mq-text">{row?.query ?? q.query_id}</span>
                          <span className="mq-reason">{q.reason}</span>
                        </li>
                      );
                    })}
                  </ol>
                </details>
                <p className="modal-note">{card.note}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Gauge({ label, value }: { label: string; value: string }) {
  return (
    <div className="gauge">
      <span className="gauge-value">{value}</span>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

function Hits({ status, latency, hits, error }: { status: "running" | "done" | "error"; latency: number; hits: HitSummary[]; error?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? hits : hits.slice(0, 2);
  return (
    <div className={`hits ${status}`}>
      <span className="hits-ms">{status === "running" ? <span className="lamp on small" /> : status === "error" ? "failed" : `${fmtMs(latency)} · ${hits.length}`}</span>
      {error && <span className="hits-err">{error}</span>}
      {shown.map((h) => (
        <a key={h.url} className="hit" href={h.url} target="_blank" rel="noreferrer" title={h.url}>
          <span className="hit-title">{h.title || h.url}</span>
          <span className="hit-host">{hostOf(h.url)}</span>
        </a>
      ))}
      {hits.length > 2 && (
        <button className="textbtn dim" onClick={() => setAll((v) => !v)}>
          {all ? "fewer" : `+${hits.length - 2}`}
        </button>
      )}
    </div>
  );
}

function Dossier({
  report,
  identity,
  findings,
  sources,
  overall,
  label,
  subjectType,
  freeText,
  running,
  phase,
  onDownload,
}: {
  report: Report | null;
  identity: Report["subject"]["resolved_identity"] | null;
  findings: Finding[];
  sources: Source[];
  overall: Report["overall"] | null;
  label: string;
  subjectType: SubjectType;
  freeText: boolean;
  running: boolean;
  phase: string;
  onDownload: () => void;
}) {
  const sourcesById = useMemo(() => new Map(sources.map((s) => [s.source_id, s])), [sources]);
  const open = findings.filter((f) => f.disposition !== "false_positive");
  const closed = findings.filter((f) => f.disposition === "false_positive");
  const found = identity?.identifiers_found;
  const idBits = found ? [found.role_or_employer, found.location, found.approx_age, found.jurisdiction_or_reg_no].filter(Boolean) : [];
  const v = report?.validation;

  return (
    <article className="paper">
      <div className="paper-head">
        <span className="eyebrow">Adverse media file</span>
        {report && (
          <button className="textbtn" onClick={onDownload}>
            download record ↓
          </button>
        )}
      </div>
      <h1 className="subject-name">{identity?.primary_name || label}</h1>
      <p className="subject-line">
        {subjectType === "organization" ? "Business" : "Individual"}
        {identity?.aliases_and_transliterations.length ? ` · also known as ${identity.aliases_and_transliterations.slice(0, 4).join(", ")}` : ""}
      </p>
      {idBits.length > 0 && <p className="subject-ids">{idBits.join(" · ")}</p>}
      {!identity && (
        <p className="paper-wait">
          <span className="lamp on small" /> {PHASE_LABELS[phase] ?? "working"}…
        </p>
      )}
      {freeText && identity && <p className="paper-warn">{FREE_TEXT_DISCLAIMER}</p>}
      {report?.delivery === "cached" && <p className="paper-warn">Saved result from {report.generated_at.slice(0, 16).replace("T", " ")} UTC. {report.cache_note}</p>}

      {identity && (
        <section className="paper-section">
          <h2 className="section-title">Identity</h2>
          <p className="identity-note">
            <span className={`conf ${identity.resolution_confidence}`}>{identity.resolution_confidence} confidence.</span> {identity.resolution_note}
          </p>
        </section>
      )}

      <section className="paper-section rating-section">
        <h2 className="section-title">{overall?.rating_label ?? "Rating"}</h2>
        {overall ? (
          <>
            <p className={`verdict ${overall.risk_rating}`}>
              <span className="verdict-risk">{overall.risk_rating} risk</span>
              <span className="verdict-sep">—</span>
              <span className="verdict-action">{ACTION_LABELS[overall.recommended_action]}</span>
            </p>
            <p className="rationale">{overall.rating_rationale}</p>
            {overall.open_items.length > 0 && (
              <ul className="open-items">
                {overall.open_items.slice(0, 3).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <p className="signoff">The tool recommends; a person decides and signs.</p>
          </>
        ) : (
          <p className="dim-text">{identity ? "Set once the findings are written." : "—"}</p>
        )}
      </section>

      <section className="paper-section">
        <h2 className="section-title">
          Findings <span className="section-count">{open.length}</span>
          {running && identity && <span className="section-note">each one checked against its source as it is written</span>}
        </h2>
        {open.length === 0 && !running && report && <p className="dim-text">No true-match or inconclusive adverse findings in the sources reviewed.</p>}
        <ol className="ledger">
          {open.map((f, i) => (
            <Entry key={f.finding_id} n={i + 1} finding={f} sources={sourcesById} />
          ))}
        </ol>
        {closed.length > 0 && (
          <details className="closed">
            <summary>
              {closed.length} false positive{closed.length === 1 ? "" : "s"} seen and closed
            </summary>
            <ol className="ledger">
              {closed.map((f, i) => (
                <Entry key={f.finding_id} n={open.length + i + 1} finding={f} sources={sourcesById} />
              ))}
            </ol>
          </details>
        )}
      </section>

      {report && v && (
        <>
          <details className="memo">
            <summary>Analyst memo</summary>
            {report.narrative.split("\n\n").map((para, i) => (
              <p key={i}>
                {para.split(/(\[[sq]\d+\])/).map((part, j) => {
                  const m = part.match(/^\[([sq])(\d+)\]$/);
                  if (!m) return <span key={j}>{part}</span>;
                  const id = `${m[1]}${m[2]}`;
                  const src = sourcesById.get(id);
                  return src ? (
                    <a key={j} className="cite" href={src.url} target="_blank" rel="noreferrer" title={`${src.publisher}: ${src.title}`}>
                      {id}
                    </a>
                  ) : (
                    <span key={j} className="cite" title="Query in the record">
                      {id}
                    </span>
                  );
                })}
              </p>
            ))}
          </details>
          <footer className="paper-foot">
            <p>
              Citation check: {v.findings_kept} of {v.findings_returned} findings passed
              {v.dropped_findings.length > 0 && `, ${v.dropped_findings.length} removed`}
              {v.removed_sentences.length > 0 && `, ${v.removed_sentences.length} uncited sentence(s) removed`}. {report.sources.length} sources returned, {report.sources.filter((s) => s.cited).length} cited. Index as of{" "}
              {report.search_scope.as_of}.
            </p>
            <p className="limits">{report.limitations}</p>
          </footer>
        </>
      )}
    </article>
  );
}

function Entry({ n, finding, sources }: { n: number; finding: Finding; sources: Map<string, Source> }) {
  return (
    <li className={`entry ${finding.disposition}`}>
      <div className="entry-head">
        <span className="entry-n">{String(n).padStart(2, "0")}</span>
        <span className="entry-meta">
          <b className={`dispo ${finding.disposition}`}>{DISPOSITION_LABELS[finding.disposition]}</b>
          <span className="sep">·</span>
          {RISK_LABELS[finding.risk_category] ?? finding.risk_category}
          <span className="sep">·</span>
          {STAGE_LABELS[finding.matter_stage] ?? finding.matter_stage}
          <span className="sep">·</span>
          <span className="mono">{finding.event_date ?? "undated"}</span>
        </span>
      </div>
      <p className="entry-summary">{finding.summary}</p>
      <p className="entry-quote">“{finding.quoted_support}”</p>
      <p className="entry-why">{finding.disposition_rationale}</p>
      <p className="entry-srcs">
        {finding.source_ids.map((id, i) => {
          const s = sources.get(id);
          if (!s) return null;
          return (
            <span key={id}>
              {i > 0 && <span className="sep">·</span>}
              <a href={s.url} target="_blank" rel="noreferrer" title={s.title}>
                {hostOf(s.url)}
              </a>{" "}
              <span className={`rel ${s.reliability}`}>{RELIABILITY_LABELS[s.reliability]}</span>
            </span>
          );
        })}
      </p>
    </li>
  );
}
