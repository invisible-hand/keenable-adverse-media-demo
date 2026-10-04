// Runs one check from the terminal and prints the event stream.
//   npx tsx scripts/check.ts "Tornado Cash" organization [realtime]
import path from "node:path";
process.loadEnvFile(path.join(process.cwd(), ".env.local"));

async function main() {
  const { runCheck } = await import("../lib/pipeline");
  const [name, subject_type = "", mode = "realtime"] = process.argv.slice(2);
  if (!name) {
    console.error('usage: npx tsx scripts/check.ts "<name>" [individual|organization] [pro|realtime]');
    process.exit(1);
  }
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;
  const queries = new Map<string, string>();
  try {
    const report = await runCheck(
      { name, subject_type: subject_type === "individual" || subject_type === "organization" ? subject_type : undefined, identifiers: { country: "", dob_or_age: "", employer_or_role: "", other: "" }, mode: mode as "pro" | "realtime" },
      (e) => {
        if (e.type === "query_started") queries.set(e.query_id, `[${e.category}] ${e.query}${e.params.site ? `  site:${e.params.site}` : ""}`);
        else if (e.type === "query_finished") console.log(stamp(), e.query_id.padEnd(4), e.error ? `ERROR ${e.error}` : `${String(e.latency_ms).padStart(5)} ms ${String(e.result_count).padStart(2)} hits`, queries.get(e.query_id));
        else if (e.type === "fetch_finished") console.log(stamp(), "fetch", e.error ? `ERROR ${e.error}` : `${String(e.latency_ms).padStart(5)} ms ${e.chars} chars${e.live ? " (live)" : ""}`, e.url);
        else if (e.type === "phase" || e.type === "check_started") console.log(stamp(), JSON.stringify(e));
        else if (e.type === "partial_overall") console.log(stamp(), "overall:", e.overall.risk_rating, e.overall.recommended_action);
        else if (e.type === "partial_identity") console.log(stamp(), "identity:", e.resolved_identity.primary_name);
        else if (e.type === "partial_finding") console.log(stamp(), "finding:", e.finding.disposition, e.finding.matter_stage, e.finding.summary.slice(0, 90));
      },
    );
    const S = process.env.SCRATCH_OUT;
    if (S) (await import("node:fs")).writeFileSync(S, JSON.stringify(report, null, 2));
    const r = report;
    console.log(`\nIDENTITY  ${r.subject.resolved_identity.primary_name} [${r.subject.resolved_identity.resolution_confidence}] ${r.subject.resolved_identity.resolution_note}`);
    console.log(`OVERALL   ${r.overall.risk_rating} / ${r.overall.recommended_action}: ${r.overall.rating_rationale}`);
    for (const f of r.findings) console.log(`\n${f.finding_id} ${f.disposition} | ${f.risk_category} | ${f.matter_stage} | ${f.event_date} | ${f.source_ids.join(",")}\n   ${f.summary}\n   quote: ${f.quoted_support}\n   why: ${f.disposition_rationale}`);
    console.log(`\nNARRATIVE\n${r.narrative}`);
    console.log(`\nOPEN ITEMS\n- ${r.overall.open_items.join("\n- ")}`);
    console.log(`\nVALIDATION ${JSON.stringify(r.validation)}`);
    console.log(`METRICS ${JSON.stringify(r.metrics)}  served_by=${r.llm.served_by}`);
  } catch (err) {
    console.log(stamp(), "FAILED:", err instanceof Error ? err.message : err);
  }
}
main();
