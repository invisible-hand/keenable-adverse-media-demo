import { z } from "zod";
import type { JudgeResult } from "./judge";

export type SubjectType = "individual" | "organization";
export type SearchMode = "pro" | "realtime";

export interface Identifiers {
  country: string;
  dob_or_age: string;
  employer_or_role: string;
  other: string;
}

export interface CheckRequest {
  name: string;
  /** Known for presets; inferred by the planner for free-text checks. */
  subject_type?: SubjectType;
  identifiers: Identifiers;
  mode: SearchMode;
  /** Set for preset checks only. Free-text checks are never cached or stored. */
  preset_id?: string;
  /** Run the same queries through the comparison provider as well. */
  compare?: boolean;
}

export const QUERY_CATEGORIES = [
  "news",
  "litigation",
  "sanctions_enforcement",
  "company_website",
  "reviews",
  "officers_associates",
  "identity",
  "alias_variant",
  "native_language",
] as const;
export type QueryCategory = (typeof QUERY_CATEGORIES)[number];

export interface PlannedQuery {
  category: QueryCategory;
  query: string;
  site?: string;
  published_after?: string;
  /** Why the query is in the plan, shown in the audit log. */
  note?: string;
}

export const RISK_CATEGORIES = [
  "financial_crime",
  "fraud",
  "bribery_corruption",
  "sanctions",
  "terrorism_financing",
  "trafficking",
  "narcotics",
  "organised_crime",
  "tax_crime",
  "cybercrime",
  "market_abuse",
  "regulatory_enforcement",
  "other",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const MATTER_STAGES = [
  "allegation",
  "investigation",
  "charged",
  "settled",
  "convicted",
  "acquitted_or_dismissed",
  "sanctioned",
  "delisted",
  "unknown",
] as const;
export type MatterStage = (typeof MATTER_STAGES)[number];

export const RELIABILITY = ["primary_official", "established_media", "trade_or_local", "unverified"] as const;
export type Reliability = (typeof RELIABILITY)[number];

const Confidence = z.enum(["high", "medium", "low"]);

/** The part of the report the LLM writes. Everything else is assembled server-side from what was actually retrieved. */
export const ExtractionSchema = z.object({
  resolved_identity: z.object({
    primary_name: z.string(),
    aliases_and_transliterations: z.array(z.string()),
    identifiers_found: z.object({
      location: z.string(),
      role_or_employer: z.string(),
      approx_age: z.string(),
      jurisdiction_or_reg_no: z.string(),
      officers_or_associates: z.array(z.string()),
    }),
    resolution_confidence: Confidence,
    resolution_note: z.string(),
  }),
  findings: z.array(
    z.object({
      risk_category: z.enum(RISK_CATEGORIES),
      summary: z.string(),
      matter_stage: z.enum(MATTER_STAGES),
      event_date: z.string().nullable(),
      source_ids: z.array(z.string()),
      quoted_support: z.string(),
      match_confidence: Confidence,
      disposition: z.enum(["true_match", "false_positive", "inconclusive"]),
      disposition_rationale: z.string(),
    }),
  ),
  overall: z.object({
    risk_rating: z.enum(["low", "medium", "high"]),
    rating_rationale: z.string(),
    recommended_action: z.enum(["clear", "escalate_to_edd", "refer_for_sar_consideration", "insufficient_information"]),
    open_items: z.array(z.string()),
  }),
  narrative_paragraphs: z.array(
    z.object({
      sentences: z.array(z.object({ text: z.string(), citations: z.array(z.string()) })),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const VariantPlanSchema = z.object({
  subject_type: z.enum(["individual", "organization"]),
  aliases_and_transliterations: z.array(z.string()),
  queries: z.array(
    z.object({
      category: z.enum(["alias_variant", "native_language", "sanctions_enforcement"]),
      query: z.string(),
      /** Domain to restrict the query to, for a country-specific enforcement site. */
      site: z.string().nullable(),
      note: z.string(),
    }),
  ),
});
export type VariantPlan = z.infer<typeof VariantPlanSchema>;

export interface AuditEntry {
  query_id: string;
  category: QueryCategory;
  query: string;
  params: Record<string, string | number>;
  note?: string;
  started_at: string;
  latency_ms: number;
  attempts: number;
  result_count: number;
  result_urls: string[];
  error?: string;
}

export interface FetchEntry {
  url: string;
  source_id: string;
  started_at: string;
  latency_ms: number;
  live: boolean;
  chars: number;
  error?: string;
}

export interface Source {
  source_id: string;
  url: string;
  title: string;
  publisher: string;
  published_at: string | null;
  retrieved_at: string;
  query_id: string;
  query_ids: string[];
  reliability: Reliability;
  language: string;
  fetched: boolean;
  cited: boolean;
}

export interface Finding {
  finding_id: string;
  risk_category: RiskCategory;
  summary: string;
  matter_stage: MatterStage;
  event_date: string | null;
  source_ids: string[];
  quoted_support: string;
  match_confidence: "high" | "medium" | "low";
  disposition: "true_match" | "false_positive" | "inconclusive";
  disposition_rationale: string;
}

export interface Metrics {
  searches: number;
  fetches: number;
  search_latency_ms_p50: number;
  search_latency_ms_p95: number;
  fetch_latency_ms_p50: number;
  total_wall_ms: number;
  llm_ms: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  search_cost_usd: number;
  fetch_cost_usd: number;
  price_basis: string;
}

/** What a visitor sees of a result while the check runs. */
export interface HitSummary {
  title: string;
  url: string;
  published_at: string | null;
  snippet?: string;
}

export interface ComparisonRow {
  query_id: string;
  hits: HitSummary[];
  latency_ms: number;
  result_count: number;
  /** Results whose URL the primary provider also returned for the same query. */
  overlap: number;
  cost_usd: number;
  error?: string;
}

export interface ProviderTotals {
  searches: number;
  latency_ms_p50: number;
  latency_ms_p95: number;
  results: number;
  cost_usd: number;
  price_basis: string;
}

export interface Comparison {
  provider: string;
  label: string;
  mode_note: string;
  /** Totals over the queries both providers answered. */
  primary: ProviderTotals;
  other: ProviderTotals;
  url_overlap_pct: number;
  rows: ComparisonRow[];
}

export interface ValidationReport {
  findings_returned: number;
  findings_kept: number;
  dropped_findings: { summary: string; reason: string }[];
  removed_sentences: { sentence: string; reason: string }[];
  uncited_claims: number;
}

export interface Report {
  check_id: string;
  generated_at: string;
  free_text: boolean;
  delivery: "live" | "cached";
  cache_note?: string;
  subject: {
    input_name: string;
    subject_type: SubjectType;
    user_supplied_identifiers: Identifiers;
    resolved_identity: Extraction["resolved_identity"];
  };
  search_scope: {
    categories_covered: string[];
    languages: string[];
    date_range: string;
    as_of: string;
    provider: string;
    mode: SearchMode;
  };
  audit_log: AuditEntry[];
  fetch_log: FetchEntry[];
  sources: Source[];
  findings: Finding[];
  overall: Extraction["overall"] & { rating_label: string };
  narrative: string;
  validation: ValidationReport;
  comparison?: Comparison;
  judgement?: JudgeResult;
  metrics: Metrics;
  llm: { model: string; served_by: string };
  limitations: string;
}

export type CheckEvent =
  | { type: "check_started"; check_id: string; as_of: string; mode: SearchMode; provider: string; max_queries: number }
  | { type: "query_started"; query_id: string; category: QueryCategory; query: string; params: Record<string, string | number>; note?: string; started_at: string }
  | { type: "query_finished"; query_id: string; latency_ms: number; result_count: number; attempts: number; hits: HitSummary[]; error?: string }
  | { type: "compare_finished"; provider: string; row: ComparisonRow }
  | { type: "judge"; judgement: JudgeResult }
  | { type: "judge_failed"; message: string }
  | { type: "fetch_started"; source_id: string; url: string }
  | { type: "fetch_finished"; source_id: string; url: string; latency_ms: number; chars: number; live: boolean; error?: string }
  | { type: "phase"; phase: "planning" | "searching" | "fetching" | "analysing" | "validating"; detail?: string }
  | { type: "partial_identity"; resolved_identity: Extraction["resolved_identity"] }
  | { type: "partial_finding"; finding: Finding; sources: Source[] }
  | { type: "partial_overall"; overall: Extraction["overall"] }
  | { type: "report"; report: Report }
  | { type: "error"; message: string; stage: string };

export const LIMITATIONS =
  "Unverified open-web findings. Not a sanctions list screen, not a determination about any person or entity, not legal advice. Human review required.";

export const FREE_TEXT_DISCLAIMER =
  "Results are unverified findings from the open web. They may refer to a different person or entity with the same name. This is not a determination about anyone.";
