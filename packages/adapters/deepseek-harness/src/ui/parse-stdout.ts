import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

export function parseDeepseekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: trimmed }];
  }
  if (parsed.paperclipDeepseek !== 1) {
    return [{ kind: "stdout", ts, text: trimmed }];
  }
  return [{ kind: "stdout", ts, text: trimmed }];
}
