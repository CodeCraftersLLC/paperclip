import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function printDeepseekStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed || parsed.paperclipDeepseek !== 1) {
    console.log(line);
    return;
  }
  const method = typeof parsed.method === "string" ? parsed.method : "event";
  console.log(pc.cyan(`deepseek ${method}`));
}
