import type { Reliability } from "./types";

const TRACKING_PARAMS = /^(utm_\w+|bm-verify|originationcontext|useskin|fbclid|gclid|ref|ref_src|cmpid|smid)$/i;

/** Key used to treat two retrieved URLs as the same page. The original URL is kept for display. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.protocol = "https:";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/** URL shown to the user: the original with tracking parameters removed. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const OFFICIAL_SUFFIXES = [".gov", ".mil", ".gov.uk", ".gov.au", ".gov.sg", ".gov.hk", ".gov.cn", ".gov.br", ".gc.ca", ".europa.eu", ".judiciary.uk"];
const OFFICIAL_HOSTS = [
  "europa.eu",
  "un.org",
  "interpol.int",
  "fatf-gafi.org",
  "finra.org",
  "fca.org.uk",
  "bankofengland.co.uk",
  "worldbank.org",
  "sfc.hk",
  "finanstilsynet.dk",
  "fi.ee",
  "bafin.de",
  "amf-france.org",
  "finma.ch",
];

const ESTABLISHED_MEDIA = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "bbc.com",
  "bbc.co.uk",
  "theguardian.com",
  "economist.com",
  "cnbc.com",
  "cnn.com",
  "npr.org",
  "forbes.com",
  "fortune.com",
  "politico.com",
  "axios.com",
  "latimes.com",
  "usatoday.com",
  "abcnews.go.com",
  "nbcnews.com",
  "cbsnews.com",
  "pbs.org",
  "dw.com",
  "france24.com",
  "aljazeera.com",
  "scmp.com",
  "nikkei.com",
  "lemonde.fr",
  "spiegel.de",
  "elpais.com",
  "folha.uol.com.br",
  "globo.com",
  "voanews.com",
  "voachinese.com",
  "rfa.org",
  "propublica.org",
  "occrp.org",
  "icij.org",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "independent.co.uk",
  "straitstimes.com",
  "caixin.com",
  "time.com",
  "theatlantic.com",
  "newyorker.com",
];

function hostMatches(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith("." + d));
}

const TRADE_OR_LOCAL = [
  "americanbanker.com",
  "law360.com",
  "law.com",
  "finextra.com",
  "pymnts.com",
  "bankingdive.com",
  "paymentsdive.com",
  "complianceweek.com",
  "globalinvestigationsreview.com",
  "fcpablog.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "arstechnica.com",
  "coindesk.com",
  "theblock.co",
  "cointelegraph.com",
  "decrypt.co",
  "dlnews.com",
  "businessinsider.com",
  "marketwatch.com",
  "barrons.com",
  "investopedia.com",
  "courthousenews.com",
  "courtlistener.com",
  "csbs.org",
  "thedailybeast.com",
  "vice.com",
  "err.ee",
  "berlingske.dk",
  "valor.globo.com",
  "malaysiakini.com",
  "thestar.com.my",
  "kyivpost.com",
  "themoscowtimes.com",
];

/**
 * Reliability decided by publisher domain. Anything not on a list is "unverified": an outlet
 * the tool cannot vouch for is treated as unknown provenance, which is the cautious reading.
 */
export function reliabilityByDomain(url: string): Reliability | null {
  const host = domainOf(url);
  if (!host) return null;
  if (OFFICIAL_SUFFIXES.some((s) => host.endsWith(s)) || hostMatches(host, OFFICIAL_HOSTS)) return "primary_official";
  if (hostMatches(host, ESTABLISHED_MEDIA)) return "established_media";
  if (hostMatches(host, TRADE_OR_LOCAL)) return "trade_or_local";
  return null;
}

/** Orders results by publisher tier (official, established media, trade, unlisted), keeping the engine's order within a tier. */
export function rankByAuthority<T extends { url: string }>(hits: T[]): T[] {
  const tier = (url: string) => {
    const r = reliabilityByDomain(url);
    return r === "primary_official" ? 0 : r === "established_media" ? 1 : r === "trade_or_local" ? 2 : 3;
  };
  return hits.map((h, i) => ({ h, i, t: tier(h.url) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.h);
}

/** Rough language tag from the script of the text, enough to show which languages the cited sources cover. */
export function languageOf(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  return "en";
}

/**
 * Flatten text for quote matching: markdown links become their label, emphasis and heading
 * marks go, typographic quotes and dashes are folded, whitespace collapses, case is ignored.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]/g, " ")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when the quote appears verbatim (after normalisation) in the source text. Elided quotes ("a ... b") must match part by part, in order. */
export function quoteAppearsIn(quote: string, normalizedSource: string): boolean {
  const parts = quote
    .split(/\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*/)
    .map((p) => normalizeForMatch(p).replace(/^["']+|["']+$/g, ""))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (parts.join(" ").length < 12) return false;
  let from = 0;
  for (const part of parts) {
    const at = normalizedSource.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
