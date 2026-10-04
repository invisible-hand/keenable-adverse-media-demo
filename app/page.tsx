import Console from "@/components/Console";
import { compareProvider } from "@/lib/exa";
import { llmModel } from "@/lib/llm";
import { maxQueries } from "@/lib/planner";
import { PRESETS } from "@/lib/presets";

export const dynamic = "force-dynamic";

export default function Home() {
  return <Console presets={PRESETS} llmModel={llmModel()} maxQueries={maxQueries()} compareLabel={compareProvider()?.label ?? null} />;
}
