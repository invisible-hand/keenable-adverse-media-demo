import type { CheckRequest, PlannedQuery } from "./types";

/** Regulator and enforcement sites searched with a `site` filter. */
const ENFORCEMENT_SITES = ["justice.gov", "treasury.gov"];
/** Financial-crime and consumer-finance enforcement. */
const BUSINESS_ENFORCEMENT_SITES = ["fincen.gov", "consumerfinance.gov"];

/**
 * The fixed part of the plan: the same query templates for every subject of a given type,
 * so two checks on the same name are comparable and the plan is explainable to a reviewer.
 *
 * Most queries carry one disambiguator so a common name stays on the right subject. A few
 * run on the bare name on purpose: namesake hits have to be seen to be closed as false positives.
 */
export function deterministicPlan(req: CheckRequest): PlannedQuery[] {
  const name = req.name.trim();
  const ids = req.identifiers;
  // One short disambiguator keeps a common name on the right subject; free-text context is cut to its first words.
  const hint = [ids.employer_or_role, ids.country, ids.other.split(/\s+/).slice(0, 8).join(" ")].map((s) => s.trim()).filter(Boolean)[0] ?? "";
  // A legal name that already contains the name as typed ("Block, Inc.") replaces it rather than repeating it.
  const withHint = (h: string) => (!h ? name : h.toLowerCase().includes(name.toLowerCase()) ? h : `${name} ${h}`);
  const named = withHint(hint);
  // Official sites index the entity by name; free context only pushes the right page down.
  const siteNamed = withHint([ids.employer_or_role, ids.country].map((s) => s.trim()).filter(Boolean)[0] ?? "");

  // On justice.gov the bare name tends to return whatever mentions it most; the case terms pull the charging and plea releases up.
  const site = (domain: string): PlannedQuery => ({
    category: "sanctions_enforcement",
    query: domain === "justice.gov" ? `${siteNamed} charged guilty plea settlement sanctions enforcement` : siteNamed,
    site: domain,
    note: `Official releases on ${domain}`,
  });

  // The same plan serves people and companies; the model works out which it is while these run.
  return [
    { category: "news", query: `${named} investigation fraud lawsuit money laundering allegations`, note: "Adverse news" },
    { category: "news", query: `${name} charged convicted sentenced fine penalty enforcement`, note: "Criminal and regulatory matters, name as typed" },
    ...[...ENFORCEMENT_SITES, ...BUSINESS_ENFORCEMENT_SITES].map(site),
    { category: "news", query: `${name} news`, published_after: "1y", note: "Last 12 months, name as typed" },
    { category: "identity", query: `${named} profile biography official website founders role`, note: "Identity: who this is" },
  ];
}

export function maxQueries(): number {
  const n = Number(process.env.MAX_QUERIES_PER_CHECK);
  return Number.isFinite(n) && n >= 4 ? Math.min(Math.floor(n), 30) : 10;
}

/** Languages the planner may add native-language queries in, as ISO 639-1 codes. */
export function queryLanguages(): string[] {
  return (process.env.QUERY_LANGUAGES ?? "zh")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Search mode for every check. The UI has no toggle; realtime measured as fast with the same official pages found. */
export function searchMode(): "pro" | "realtime" {
  return process.env.SEARCH_MODE === "pro" ? "pro" : "realtime";
}
