function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block && block.type === "text" && typeof block.text === "string"))
    .map((block) => String(block.text))
    .join("");
}

function thinkingFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => {
      if (!block || typeof block.text !== "string") return false;
      return block.type === "reasoning" || block.type === "thinking";
    })
    .map((block) => String(block.text))
    .join("");
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    return parsed ?? value;
  }
  return value ?? {};
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromRecord(value: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number } | null {
  const usage = asRecord(value);
  if (!usage) return null;
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cachedTokens: tokenCount(usage.cacheReadTokens),
  };
}

function addUsage(
  left: { inputTokens: number; outputTokens: number; cachedTokens: number },
  right: { inputTokens: number; outputTokens: number; cachedTokens: number },
) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
  };
}

function toolResultCard(data: Record<string, unknown>, ts: string): Record<string, unknown> | null {
  const message = asRecord(data.message);
  const blocks = message?.content;
  const first = Array.isArray(blocks) ? asRecord(blocks[0]) : null;
  const toolUseId = asString(first?.toolCallId, asString(data.callId, asString(data.id)));
  if (!toolUseId) return null;
  const inner = first?.content;
  let content = "";
  if (typeof inner === "string") content = inner;
  else if (Array.isArray(inner)) content = textFromBlocks(inner);
  else if (inner != null) content = JSON.stringify(inner);
  const isError = first?.isError === true || Boolean(data.error);
  return {
    kind: "tool_result",
    ts,
    toolUseId,
    toolName: asString(data.name, "tool"),
    content,
    isError,
  };
}

function turnEndStderr(data: Record<string, unknown>, ts: string): Record<string, unknown> | null {
  const reason = asRecord(data.reason);
  const kind = asString(reason?.kind);
  if (kind === "error") {
    const error = asRecord(reason?.error);
    const text = asString(error?.message) || asString(error?.code) || "DeepSeek Harness turn ended with an error";
    return { kind: "stderr", ts, text };
  }
  if (kind === "max-tokens") {
    return { kind: "stderr", ts, text: "DeepSeek Harness turn ended: max-tokens" };
  }
  return null;
}

type ParserState = {
  messageUsage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  chunkUsage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  sawMessageUsage: boolean;
  streamedText: boolean;
  streamedThinking: boolean;
};

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function emptyState(): ParserState {
  return {
    messageUsage: emptyUsage(),
    chunkUsage: emptyUsage(),
    sawMessageUsage: false,
    streamedText: false,
    streamedThinking: false,
  };
}

function resultUsage(state: ParserState) {
  return state.sawMessageUsage ? state.messageUsage : state.chunkUsage;
}

function parseProtocolLine(line: string, ts: string, state: ParserState | null): Array<Record<string, unknown>> {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return [];
  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed || parsed.paperclipDeepseek !== 1) {
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const method = asString(parsed.method);
  const params = asRecord(parsed.params) ?? {};

  if (method === "subagent.started") {
    return [{ kind: "system", ts, text: `Subagent started ${asString(params.childSessionId)}`.trim() }];
  }
  if (method === "subagent.finished") {
    return [{ kind: "system", ts, text: `Subagent finished ${asString(params.childSessionId)}`.trim() }];
  }
  if (method === "session.status" && params.status === "idle") {
    if (!state) return [];
    return [{
      kind: "result",
      ts,
      text: "Run completed",
      inputTokens: resultUsage(state).inputTokens,
      outputTokens: resultUsage(state).outputTokens,
      cachedTokens: resultUsage(state).cachedTokens,
      costUsd: 0,
      subtype: "end",
      isError: false,
      errors: [],
    }];
  }
  if (method !== "session.event") {
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const event = asRecord(params.event);
  if (!event) return [];
  const type = asString(event.type);
  const data = asRecord(event.data) ?? {};

  if (type === "assistant/chunk") {
    const chunk = asRecord(data.chunk) ?? {};
    const chunkType = asString(chunk.type);
    if (chunkType === "usage") {
      const usage = usageFromRecord(chunk.usage);
      if (usage && state) state.chunkUsage = addUsage(state.chunkUsage, usage);
      return [];
    }
    const text = asString(chunk.text);
    if (!text) return [];
    if (chunkType === "reasoning-delta") {
      if (state) state.streamedThinking = true;
      return [{ kind: "thinking", ts, text, delta: true }];
    }
    if (chunkType === "text-delta") {
      if (state) state.streamedText = true;
      return [{ kind: "assistant", ts, text, delta: true }];
    }
    return [];
  }

  if (type === "assistant/message") {
    const message = asRecord(data.message) ?? {};
    const content = message.content;
    const usage = usageFromRecord(data.usage);
    if (usage && state) {
      state.messageUsage = addUsage(state.messageUsage, usage);
      state.sawMessageUsage = true;
    }
    const entries: Array<Record<string, unknown>> = [];
    const thinking = thinkingFromBlocks(content);
    const text = textFromBlocks(content);
    if (thinking && !state?.streamedThinking) entries.push({ kind: "thinking", ts, text: thinking });
    if (text && !state?.streamedText) entries.push({ kind: "assistant", ts, text });
    return entries;
  }

  if (type === "tool/call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(data.name, "tool"),
      input: parseToolArguments(data.arguments),
      toolUseId: asString(data.callId, asString(data.id)),
    }];
  }

  if (type === "tool/result") {
    const card = toolResultCard(data, ts);
    return card ? [card] : [];
  }

  if (type === "user/message") {
    const message = asRecord(data.message) ?? data;
    const text = textFromBlocks(message.content) || asString(data.text);
    if (!text) return [];
    return [{ kind: "user", ts, text }];
  }

  if (type === "turn/end") {
    const stderr = turnEndStderr(data, ts);
    return stderr ? [stderr] : [];
  }

  return [];
}

export function createStdoutParser() {
  let state = emptyState();
  return {
    parseLine(line: string, ts: string): Array<Record<string, unknown>> {
      return parseProtocolLine(line, ts, state);
    },
    reset() {
      state = emptyState();
    },
  };
}

export function parseStdoutLine(line: string, ts: string): Array<Record<string, unknown>> {
  return createStdoutParser().parseLine(line, ts);
}
