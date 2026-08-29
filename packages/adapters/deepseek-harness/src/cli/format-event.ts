import pc from "picocolors";
import { parseStdoutLine } from "../ui-parser.js";

export function printDeepseekStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const entries = parseStdoutLine(line, new Date().toISOString());
  if (entries.length === 0) return;
  for (const entry of entries) {
    const kind = typeof entry.kind === "string" ? entry.kind : "stdout";
    if (kind === "assistant") {
      console.log(pc.green(String(entry.text ?? "")));
      continue;
    }
    if (kind === "thinking") {
      console.log(pc.magenta(String(entry.text ?? "")));
      continue;
    }
    if (kind === "tool_call") {
      console.log(pc.yellow(`tool ${String(entry.name ?? "tool")}`));
      continue;
    }
    if (kind === "tool_result") {
      const printer = entry.isError ? pc.red : pc.gray;
      console.log(printer(String(entry.content ?? "")));
      continue;
    }
    if (kind === "stderr") {
      console.log(pc.red(String(entry.text ?? "")));
      continue;
    }
    if (kind === "system" || kind === "result") {
      console.log(pc.cyan(String(entry.text ?? kind)));
      continue;
    }
    if (typeof entry.text === "string" && entry.text) console.log(entry.text);
  }
}
