import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseStdoutLine } from "../ui-parser.js";

export function parseDeepseekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseStdoutLine(line, ts) as TranscriptEntry[];
}
