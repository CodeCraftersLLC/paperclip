import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { createStdoutParser, parseStdoutLine } from "../ui-parser.js";

export function parseDeepseekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseStdoutLine(line, ts) as TranscriptEntry[];
}

export function createDeepseekStdoutParser() {
  const parser = createStdoutParser();
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parser.parseLine(line, ts) as TranscriptEntry[];
    },
    reset() {
      parser.reset();
    },
  };
}
