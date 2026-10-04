import { readCachedReport } from "@/lib/cache";
import { compareProvider } from "@/lib/exa";
import { keenable } from "@/lib/keenable";
import { CheckError, runCheck } from "@/lib/pipeline";
import { searchMode } from "@/lib/planner";
import { presetById } from "@/lib/presets";
import { takeRateLimit } from "@/lib/ratelimit";
import type { CheckEvent, CheckRequest, Identifiers } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 10_000) return Response.json({ error: "Request too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

  const preset = presetById(clean(body.preset_id, 60));
  const rawIds = (body.identifiers ?? {}) as Record<string, unknown>;
  const identifiers: Identifiers = preset?.identifiers ?? {
    country: clean(rawIds.country, 80),
    dob_or_age: clean(rawIds.dob_or_age, 40),
    employer_or_role: clean(rawIds.employer_or_role, 120),
    other: clean(body.context ?? rawIds.other, 240),
  };
  const req: CheckRequest = {
    name: preset?.name ?? clean(body.name, 120),
    subject_type: preset?.subject_type ?? (body.subject_type === "individual" || body.subject_type === "organization" ? body.subject_type : undefined),
    identifiers,
    mode: searchMode(),
    preset_id: preset?.id,
  };
  if (req.name.length < 2) return Response.json({ error: "Enter a name of at least two characters" }, { status: 400 });

  const wantCached = body.cached === true && Boolean(preset);
  if (!wantCached) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const gate = takeRateLimit(ip);
    if (!gate.ok) {
      return Response.json({ error: `Rate limit reached. Try again in ${Math.ceil(gate.retry_after_s / 60)} min.` }, { status: 429, headers: { "Retry-After": String(gate.retry_after_s) } });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: CheckEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      const sendCached = async (note: string): Promise<boolean> => {
        const cached = preset ? await readCachedReport(preset.id) : null;
        if (!cached) return false;
        emit({ type: "report", report: { ...cached, delivery: "cached", cache_note: note } });
        return true;
      };

      try {
        if (wantCached) {
          if (!(await sendCached("Saved result from the last test run"))) {
            emit({ type: "error", stage: "cache", message: "No saved result for this preset yet. Run it live once, or run the preset test script." });
          }
        } else {
          // runCheck emits the report itself, then waits for the judge before returning.
          await runCheck(req, emit, keenable, body.compare === false ? null : compareProvider());
        }
      } catch (err) {
        const stage = err instanceof CheckError ? err.stage : "server";
        const message = err instanceof Error ? err.message : "Unexpected error";
        // A preset falls back to its saved result so a bad network does not stop the walkthrough; the badge says so.
        if (!(await sendCached(`Live run failed at the ${stage} stage (${message}); showing the saved result`))) {
          emit({ type: "error", stage, message });
        }
      } finally {
        open = false;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
