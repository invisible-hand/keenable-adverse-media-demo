// Fetches every preset's expected_source live and prints its title and date, so the
// record stated in lib/presets.ts can be confirmed against the official page.
//   npx tsx scripts/verify-presets.ts
import path from "node:path";
process.loadEnvFile(path.join(process.cwd(), ".env.local"));

async function main() {
  const { PRESETS } = await import("../lib/presets");
  const { keenable } = await import("../lib/keenable");
  for (const p of PRESETS) {
    if (!p.expected_source) {
      const res = await keenable.search({ query: `"${p.name}"`, mode: "pro", max_results: 5, snippet_max_length: 200 });
      const exact = res.hits.filter((h) => `${h.title} ${h.snippet}`.toLowerCase().includes(p.name.toLowerCase()));
      console.log(`${p.id.padEnd(22)} control: ${res.hits.length} hits, ${exact.length} naming the subject`);
      continue;
    }
    try {
      const page = await keenable.fetchPage!(p.expected_source, { max_chars: 3000, live: true });
      const body = page.content.replace(/\s+/g, " ");
      console.log(`${p.id.padEnd(22)} OK   ${page.published_at?.slice(0, 10) ?? "no date  "} ${page.title.slice(0, 110)}`);
      console.log(`${" ".repeat(22)} says: ${p.record}`);
      console.log(`${" ".repeat(22)} page: ${body.slice(0, 420)}\n`);
    } catch (err) {
      console.log(`${p.id.padEnd(22)} FAIL ${err instanceof Error ? err.message : err}  ${p.expected_source}\n`);
    }
  }
}
main();
