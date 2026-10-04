/**
 * Reads a JSON object that is still being written and returns the parts that are already
 * complete: top-level values that have closed, and the finished elements of top-level arrays.
 * Used to show findings while the model is still writing the rest of the report.
 */
export function scanPartialJson(text: string): { values: Record<string, unknown>; items: Record<string, unknown[]> } {
  const values: Record<string, unknown> = {};
  const items: Record<string, unknown[]> = {};
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let expectKey = false;
  let key = "";
  let valueStart = -1;
  let valueIsArray = false;
  let itemStart = -1;

  const parse = (from: number, to: number): unknown => {
    try {
      return JSON.parse(text.slice(from, to));
    } catch {
      return undefined;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (depth === 1 && expectKey) {
          const parsed = parse(stringStart, i + 1);
          if (typeof parsed === "string") key = parsed;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === "{" || ch === "[") {
      depth++;
      if (depth === 1) expectKey = true;
      else if (depth === 2) {
        valueStart = i;
        valueIsArray = ch === "[";
      } else if (depth === 3 && valueIsArray && ch === "{") itemStart = i;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 2 && itemStart !== -1) {
        const item = parse(itemStart, i + 1);
        if (item !== undefined) (items[key] ??= []).push(item);
        itemStart = -1;
      } else if (depth === 1 && valueStart !== -1) {
        const value = parse(valueStart, i + 1);
        if (value !== undefined) values[key] = value;
        valueStart = -1;
      }
    } else if (ch === ":" && depth === 1) expectKey = false;
    else if (ch === "," && depth === 1) expectKey = true;
  }
  return { values, items };
}
