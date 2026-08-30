import type { AdapterExecutionErrorFamily, UsageSummary } from "@paperclipai/adapter-utils/types";

export const PROTOCOL_METHODS = {
  initialize: "initialize",
  prompt: "session/prompt",
  shutdown: "shutdown",
} as const;

export const PROTOCOL_NOTIFICATIONS = {
  sessionEvent: "session.event",
  sessionStatus: "session.status",
  subagentStarted: "subagent.started",
  subagentFinished: "subagent.finished",
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

export interface InitializeParams {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface InitializeResult {
  serverInfo?: { name?: string; version?: string };
}

export interface SessionPromptParams {
  sessionId: string;
  contentBlocks: Array<{ type: string; text?: string }>;
}

export interface SessionPromptResult {
  messageId: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInboxReceipt(event: unknown, messageId: string): boolean {
  if (!isRecord(event) || event.type !== "agent/inbox/spliced" || !isRecord(event.data)) {
    return false;
  }
  const inserted = event.data.inserted;
  return Array.isArray(inserted) && inserted.some((message) => isRecord(message) && message.id === messageId);
}

export function mapTokenUsage(usage: TokenUsage | null | undefined): UsageSummary {
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    cachedInputTokens: Number(usage?.cacheReadTokens ?? 0),
  };
}

export function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
  };
}

export function extractAssistantText(event: unknown): string {
  if (!isRecord(event) || event.type !== "assistant/message" || !isRecord(event.data)) return "";
  const message = isRecord(event.data.message) ? event.data.message : event.data;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function extractEventUsage(event: unknown): UsageSummary | null {
  if (!isRecord(event) || event.type !== "assistant/message" || !isRecord(event.data)) return null;
  const usage = isRecord(event.data.usage) ? event.data.usage : null;
  if (!usage) return null;
  return mapTokenUsage(usage as TokenUsage);
}

export function extractChunkUsage(event: unknown): UsageSummary | null {
  if (!isRecord(event) || event.type !== "assistant/chunk" || !isRecord(event.data)) return null;
  const chunk = isRecord(event.data.chunk) ? event.data.chunk : null;
  if (!chunk || chunk.type !== "usage" || !isRecord(chunk.usage)) return null;
  return mapTokenUsage(chunk.usage as TokenUsage);
}

export function extractTurnEndError(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "turn/end" || !isRecord(event.data)) return null;
  const reason = isRecord(event.data.reason) ? event.data.reason : null;
  if (!reason) return null;
  const kind = typeof reason.kind === "string" ? reason.kind : "";
  if (kind === "error") {
    const error = isRecord(reason.error) ? reason.error : null;
    if (error && typeof error.message === "string" && error.message.trim()) return error.message;
    if (error && typeof error.code === "string" && error.code.trim()) {
      return `DeepSeek Harness turn ended with an error (${error.code})`;
    }
    return "DeepSeek Harness turn ended with an error";
  }
  if (kind === "max-tokens") return "DeepSeek Harness turn ended: max-tokens";
  return null;
}

export function classifyDeepseekError(message: string): AdapterExecutionErrorFamily | null {
  const text = message.toLowerCase();
  if (/\b(quota|rate limit|too many requests|429)\b/.test(text)) return "provider_quota";
  if (/\b(refus|safety|content policy|blocked)\b/.test(text)) return "model_refusal";
  if (/\b(timeout|temporar|unavailable|502|503|504|econnreset|enotfound)\b/.test(text)) {
    return "transient_upstream";
  }
  return null;
}

export function isUnknownSessionError(message: string): boolean {
  return /unknown session|session .* not found|no such session|invalid session/i.test(message);
}
