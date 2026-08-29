import { describe, expect, it } from "vitest";
import { parseDeepseekStdoutLine } from "./parse-stdout.js";

describe("parseDeepseekStdoutLine", () => {
  it("maps tool cards, thinking deltas, and assistant text", () => {
    expect(
      parseDeepseekStdoutLine(
        JSON.stringify({
          paperclipDeepseek: 1,
          method: "session.event",
          params: {
            event: { type: "assistant/chunk", data: { type: "reasoning", text: "hmm" } },
          },
        }),
        "t0",
      ),
    ).toEqual([{ kind: "thinking", ts: "t0", text: "hmm", delta: true }]);

    expect(
      parseDeepseekStdoutLine(
        JSON.stringify({
          paperclipDeepseek: 1,
          method: "session.event",
          params: {
            event: { type: "tool/call", data: { name: "bash", callId: "c1", arguments: { cmd: "ls" } } },
          },
        }),
        "t1",
      ),
    ).toEqual([{ kind: "tool_call", ts: "t1", name: "bash", input: { cmd: "ls" }, toolUseId: "c1" }]);

    expect(
      parseDeepseekStdoutLine(
        JSON.stringify({
          paperclipDeepseek: 1,
          method: "session.event",
          params: {
            event: {
              type: "assistant/message",
              data: { message: { content: [{ type: "text", text: "done" }] } },
            },
          },
        }),
        "t2",
      ),
    ).toEqual([{ kind: "assistant", ts: "t2", text: "done" }]);
  });

  it("treats non-protocol lines as stdout", () => {
    expect(parseDeepseekStdoutLine("hello", "t3")).toEqual([{ kind: "stdout", ts: "t3", text: "hello" }]);
  });
});
