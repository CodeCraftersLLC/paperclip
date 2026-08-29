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

export function parseStdoutLine(line: string, ts: string): Array<Record<string, unknown>> {
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
    return [{
      kind: "result",
      ts,
      text: "Run completed",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
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
    const block = asRecord(data.block) ?? data;
    const blockType = asString(block.type, "text");
    const text = asString(block.text, asString(data.text));
    if (!text) return [];
    if (blockType === "reasoning" || blockType === "thinking") {
      return [{ kind: "thinking", ts, text, delta: true }];
    }
    return [{ kind: "assistant", ts, text, delta: true }];
  }

  if (type === "assistant/message") {
    const message = asRecord(data.message) ?? data;
    const content = message.content;
    const entries: Array<Record<string, unknown>> = [];
    const thinking = thinkingFromBlocks(content);
    const text = textFromBlocks(content);
    if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
    if (text) entries.push({ kind: "assistant", ts, text });
    return entries;
  }

  if (type === "tool/call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(data.name, "tool"),
      input: data.arguments ?? data.input ?? {},
      toolUseId: asString(data.callId, asString(data.id)),
    }];
  }

  if (type === "tool/result") {
    const content = typeof data.content === "string" ? data.content : JSON.stringify(data.content ?? data);
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(data.callId, asString(data.id, "tool")),
      toolName: asString(data.name, "tool"),
      content,
      isError: data.isError === true || data.ok === false,
    }];
  }

  if (type === "user/message") {
    const message = asRecord(data.message) ?? data;
    const text = textFromBlocks(message.content) || asString(data.text);
    if (!text) return [];
    return [{ kind: "user", ts, text }];
  }

  if (type === "turn/end") {
    const reason = asString(data.reason);
    const error = asString(data.error);
    if (reason === "error" || error) {
      return [{ kind: "stderr", ts, text: error || reason || "DeepSeek turn ended with an error" }];
    }
  }

  return [];
}
