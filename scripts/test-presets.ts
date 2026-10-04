// Runs every preset live and writes a results table plus the saved results the UI falls back to.
//   npx tsx scripts/test-presets.ts                 all presets
//   npx tsx scripts/test-presets.ts --only block,tornado-cash
//   npx tsx scripts/test-presets.ts --mode realtime --no-save
//   npx tsx scripts/test-presets.ts --judge            also run the comparison provider and the blind judge
import { promises as fs } from "node:fs";
import path from "node:path";
process.loadEnvFile(path.join(process.cwd(), ".env.local"));

interface Row {
  id: string;
  ok: boolean;
  problems: string[];
  rating: string;
  action: string;
  findings: string;
  stage: string;
  source_found: string;
  uncited: number;
  dropped: number;
  searches: number;
  p50: number;
  p95: number;
  wall_s: string;
  llm_s: string;
  cost: string;
  judge: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const { PRESETS } = await import("../lib/presets");
  const { runCheck } = await import("../lib/pipeline");
  const { writeCachedReport } = await import("../lib/cache");
  const { compareProvider } = await import("../lib/exa");
  const { keenable } = await import("../lib/keenable");
  const { scorecard } = await import("../lib/scorecard");

  const only = arg("only")?.split(",");
  const mode = arg("mode") === "pro" ? "pro" : arg("mode") === "realtime" ? "realtime" : (process.env.SEARCH_MODE === "pro" ? "pro" : "realtime");
  const save = !process.argv.includes("--no-save");
  const withJudge = process.argv.includes("--judge");
  const presets = PRESETS.filter((p) => !only || only.includes(p.id));
  const rows: Row[] = [];

  for (const p of presets) {
    process.stdout.write(`${p.id.padEnd(22)} `);
    try {
      const report = await runCheck({ name: p.name, subject_type: p.subject_type, identifiers: p.identifiers, mode, preset_id: p.id }, () => {}, keenable, withJudge ? compareProvider() : null, withJudge);
      const problems: string[] = [];
      const trueMatches = report.findings.filter((f) => f.disposition === "true_match");
      const falsePositives = report.findings.filter((f) => f.disposition === "false_positive");
      const inconclusive = report.findings.filter((f) => f.disposition === "inconclusive");

      if (!p.expected.actions.includes(report.overall.recommended_action)) problems.push(`action ${report.overall.recommended_action}, expected ${p.expected.actions.join(" or ")}`);
      if (p.expected_outcome === "clean" && p.expected.actions.includes("clear") && report.overall.risk_rating !== "low") problems.push(`clean control rated ${report.overall.risk_rating}`);
      if (p.expected_outcome === "adverse" && trueMatches.length === 0) problems.push("no true-match finding");

      const stages = [...new Set(trueMatches.map((f) => f.matter_stage))];
      if (p.expected.stages.length && !p.expected.stages.some((s) => stages.includes(s))) problems.push(`stage ${stages.join("/") || "none"}, expected ${p.expected.stages.join(" or ")}`);

      const hit = (url: string) => p.expected_source_fragments.some((frag) => url.toLowerCase().includes(frag.toLowerCase()));
      const retrieved = report.sources.some((s) => hit(s.url));
      const cited = report.sources.some((s) => s.cited && hit(s.url));
      if (p.expected_source && !retrieved) problems.push("expected official source not retrieved");

      // By construction nothing uncited survives validation; this counts what remains, as a check on the validator itself.
      const uncited = report.findings.filter((f) => f.source_ids.length === 0).length + report.validation.uncited_claims;
      if (uncited > 0) problems.push(`${uncited} uncited claims`);
      const removed = report.validation.dropped_findings.length + report.validation.removed_sentences.length;

      if (save) await writeCachedReport(p.id, report);
      const m = report.metrics;
      rows.push({
        id: p.id,
        ok: problems.length === 0,
        problems,
        rating: report.overall.risk_rating,
        action: report.overall.recommended_action,
        findings: `${trueMatches.length} TM / ${falsePositives.length} FP / ${inconclusive.length} inc`,
        stage: stages.join(", ") || "-",
        source_found: p.expected_source ? (cited ? "cited" : retrieved ? "retrieved" : "NO") : "n/a",
        uncited,
        dropped: removed,
        searches: m.searches,
        p50: m.search_latency_ms_p50,
        p95: m.search_latency_ms_p95,
        wall_s: (m.total_wall_ms / 1000).toFixed(1),
        llm_s: (m.llm_ms / 1000).toFixed(1),
        cost: `$${m.search_cost_usd.toFixed(3)}`,
        judge: report.judgement && report.comparison ? (() => { const c = scorecard(report.comparison, report.judgement); return `${c.winner === "primary" ? "keenable" : c.winner === "other" ? report.comparison.provider : "tie"} ${c.primary.total} vs ${c.other.total} (content ${c.primary.content} vs ${c.other.content}, judge: ${report.judgement.winner})`; })() : "-",
      });
      console.log(`${problems.length ? "FAIL" : "pass"}  ${report.overall.risk_rating}/${report.overall.recommended_action}  ${(m.total_wall_ms / 1000).toFixed(1)}s  ${report.judgement ? `judge: ${report.judgement.winner}` : ""} ${problems.join("; ")}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({ id: p.id, ok: false, problems: [message], rating: "-", action: "-", findings: "-", stage: "-", source_found: "-", uncited: 0, dropped: 0, searches: 0, p50: 0, p95: 0, wall_s: "-", llm_s: "-", cost: "-", judge: "-" });
      console.log(`ERROR ${message}`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(":", "");
  const header = "| Preset | Result | Rating | Action | Findings | Stage | Official source | Uncited | Removed by check | Searches | p50 ms | p95 ms | Wall s | LLM s | Search cost | Scorecard |";
  const lines = [
    `# Preset test run, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC (${mode} mode, ${process.env.LLM_MODEL ?? "claude-opus-5-5"}, effort ${process.env.LLM_EFFORT ?? "low"})`,
    "",
    header,
    header.replace(/[^|]+/g, "---"),
    ...rows.map((r) => `| ${r.id} | ${r.ok ? "pass" : "FAIL"} | ${r.rating} | ${r.action} | ${r.findings} | ${r.stage} | ${r.source_found} | ${r.uncited} | ${r.dropped} | ${r.searches} | ${r.p50} | ${r.p95} | ${r.wall_s} | ${r.llm_s} | ${r.cost} | ${r.judge} |`),
    "",
    "TM true match, FP false positive, inc inconclusive. \"Removed by check\" counts findings and narrative sentences the citation validator deleted.",
    "",
    ...rows.filter((r) => !r.ok).map((r) => `- **${r.id}**: ${r.problems.join("; ")}`),
  ];
  await fs.mkdir("test-results", { recursive: true });
  const file = path.join("test-results", `presets-${stamp}.md`);
  await fs.writeFile(file, lines.join("\n") + "\n");
  console.log(`\n${rows.filter((r) => r.ok).length} of ${rows.length} passed. Table: ${file}`);
  if (rows.some((r) => !r.ok)) process.exitCode = 1;
}
main();
