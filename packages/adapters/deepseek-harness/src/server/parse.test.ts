import { describe, expect, it } from "vitest";
import { parseTurnNotifications } from "./parse.js";
import { mapTokenUsage } from "./protocol.js";

describe("mapTokenUsage", () => {
  it("maps cacheReadTokens to cachedInputTokens and drops write/reasoning", () => {
    expect(
      mapTokenUsage({
        inputTokens: 22,
        outputTokens: 8,
        cacheReadTokens: 4,
        cacheWriteTokens: 9,
        reasoningTokens: 3,
      }),
    ).toEqual({ inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 });
  });
});

describe("parseTurnNotifications", () => {
  it("accumulates usage, summary, and tool name", () => {
    const parsed = parseTurnNotifications([
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: { type: "tool/call", data: { name: "bash" } },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: {
            type: "assistant/message",
            data: {
              message: { content: [{ type: "text", text: "done" }] },
              usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 },
            },
          },
        },
      },
    ]);
    expect(parsed.summary).toBe("done");
    expect(parsed.toolName).toBe("bash");
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 1 });
  });

  it("maps turn/end errors and unknown sessions", () => {
    const parsed = parseTurnNotifications([
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: { type: "turn/end", data: { reason: "error", error: "unknown session abc" } },
        },
      },
    ]);
    expect(parsed.unknownSession).toBe(true);
    expect(parsed.errorMessage).toMatch(/unknown session/);
  });
});
