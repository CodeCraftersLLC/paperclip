export function parseStdoutLine(line: string, ts: string): Array<{ kind: string; ts: string; text: string }> {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return [];
  return [{ kind: "stdout", ts, text: trimmed }];
}
