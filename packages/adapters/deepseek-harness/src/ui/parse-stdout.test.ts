import { describe, expect, it } from "vitest";
import { createDeepseekStdoutParser, parseDeepseekStdoutLine } from "./parse-stdout.js";

function eventLine(type: string, data: Record<string, unknown>) {
  return JSON.stringify({
    paperclipDeepseek: 1,
    method: "session.event",
    params: { event: { type, data } },
  });
}

describe("parseDeepseekStdoutLine", () => {
  it("maps official StreamChunk deltas, JSON-string tool arguments, and tool-result messages", () => {
    expect(
      parseDeepseekStdoutLine(
        eventLine("assistant/chunk", { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "hmm" } }),
        "t0",
      ),
    ).toEqual([{ kind: "thinking", ts: "t0", text: "hmm", delta: true }]);

    expect(
      parseDeepseekStdoutLine(
        eventLine("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "hi" } }),
        "t0b",
      ),
    ).toEqual([{ kind: "assistant", ts: "t0b", text: "hi", delta: true }]);

    expect(
      parseDeepseekStdoutLine(
        eventLine("tool/call", {
          turn: 1,
          step: 1,
          name: "bash",
          callId: "c1",
          arguments: JSON.stringify({ cmd: "ls" }),
        }),
        "t1",
      ),
    ).toEqual([{ kind: "tool_call", ts: "t1", name: "bash", input: { cmd: "ls" }, toolUseId: "c1" }]);

    expect(
      parseDeepseekStdoutLine(
        eventLine("tool/result", {
          turn: 1,
          step: 1,
          message: {
            role: "user",
            content: [{
              type: "tool-result",
              toolCallId: "c1",
              content: [{ type: "text", text: "ok" }],
              isError: false,
            }],
          },
        }),
        "t1b",
      ),
    ).toEqual([{ kind: "tool_result", ts: "t1b", toolUseId: "c1", toolName: "tool", content: "ok", isError: false }]);

    expect(
      parseDeepseekStdoutLine(
        eventLine("turn/end", {
          turn: 1,
          reason: { kind: "error", error: { message: "provider 429", code: "RATE_LIMIT" } },
        }),
        "t-err",
      ),
    ).toEqual([{ kind: "stderr", ts: "t-err", text: "provider 429" }]);
  });

  it("treats non-protocol lines as stdout", () => {
    expect(parseDeepseekStdoutLine("hello", "t3")).toEqual([{ kind: "stdout", ts: "t3", text: "hello" }]);
  });
});

describe("createDeepseekStdoutParser", () => {
  it("accumulates official usage and skips replayed assistant/message text after chunks", () => {
    const parser = createDeepseekStdoutParser();
    expect(
      parser.parseLine(
        eventLine("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hi" } }),
        "t0",
      ),
    ).toEqual([{ kind: "assistant", ts: "t0", text: "hi", delta: true }]);
    expect(
      parser.parseLine(
        eventLine("assistant/chunk", {
          turn: 1,
          step: 1,
          chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 } },
        }),
        "t1",
      ),
    ).toEqual([]);
    expect(
      parser.parseLine(
        eventLine("assistant/message", {
          turn: 1,
          step: 1,
          message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
          usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 },
        }),
        "t2",
      ),
    ).toEqual([]);
    expect(
      parser.parseLine(
        JSON.stringify({ paperclipDeepseek: 1, method: "session.status", params: { status: "idle" } }),
        "t3",
      ),
    ).toEqual([{
      kind: "result",
      ts: "t3",
      text: "Run completed",
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 3,
      costUsd: 0,
      subtype: "end",
      isError: false,
      errors: [],
    }]);
  });
});
