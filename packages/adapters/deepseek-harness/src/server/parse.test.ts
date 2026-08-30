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

  it("maps official turn/end LlmFailure and unknown sessions", () => {
    const parsed = parseTurnNotifications([
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: {
            type: "turn/end",
            data: { turn: 1, reason: { kind: "error", error: { message: "unknown session abc", code: "UNKNOWN" } } },
          },
        },
      },
    ]);
    expect(parsed.unknownSession).toBe(true);
    expect(parsed.errorMessage).toMatch(/unknown session/);
  });

  it("maps max-tokens turn/end and assistant/chunk usage", () => {
    const parsed = parseTurnNotifications([
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: {
            type: "assistant/chunk",
            data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } } },
          },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "s1",
          event: { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
        },
      },
    ]);
    expect(parsed.errorMessage).toMatch(/max-tokens/);
    expect(parsed.usage).toEqual({ inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 });
  });
});

describe("parseBridgeStdout", () => {
  it("reads the last bridge-result line", async () => {
    const { parseBridgeStdout } = await import("./parse.js");
    const parsed = parseBridgeStdout([
      JSON.stringify({ paperclipDeepseek: 1, method: "session.status", params: { status: "idle" } }),
      JSON.stringify({
        paperclipDeepseek: 1,
        kind: "bridge-result",
        sessionId: "s1",
        usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 },
        summary: "ok",
      }),
    ].join("\n"));
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.summary).toBe("ok");
    expect(parsed.usage.inputTokens).toBe(2);
  });
});
