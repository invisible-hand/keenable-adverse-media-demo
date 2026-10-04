import { promises as fs } from "node:fs";
import path from "node:path";
import type { Report } from "./types";

// Preset results only. Free-text checks are never written anywhere.
const DIR = path.join(process.cwd(), "data", "cache");

export async function readCachedReport(presetId: string): Promise<Report | null> {
  if (!/^[a-z0-9-]+$/.test(presetId)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${presetId}.json`), "utf8")) as Report;
  } catch {
    return null;
  }
}

export async function writeCachedReport(presetId: string, report: Report): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${presetId}.json`), JSON.stringify(report, null, 2));
}
