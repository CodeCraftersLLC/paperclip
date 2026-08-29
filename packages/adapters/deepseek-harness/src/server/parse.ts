import type { AdapterExecutionErrorFamily, UsageSummary } from "@paperclipai/adapter-utils/types";
import {
  addUsage,
  classifyDeepseekError,
  extractAssistantText,
  extractChunkUsage,
  extractEventUsage,
  extractTurnEndError,
  isRecord,
  isUnknownSessionError,
} from "./protocol.js";
import type { JsonRpcNotification } from "./jsonrpc-client.js";
import { PROTOCOL_NOTIFICATIONS } from "./protocol.js";

export interface DeepseekTurnParse {
  usage: UsageSummary;
  summary: string | null;
  toolName: string | null;
  errorMessage: string | null;
  errorFamily: AdapterExecutionErrorFamily | null;
  unknownSession: boolean;
}

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export function parseTurnNotifications(notifications: JsonRpcNotification[]): DeepseekTurnParse {
  let usage = EMPTY_USAGE;
  let chunkUsage = EMPTY_USAGE;
  let sawMessageUsage = false;
  let summary: string | null = null;
  let toolName: string | null = null;
  let errorMessage: string | null = null;

  for (const notification of notifications) {
    if (notification.method !== PROTOCOL_NOTIFICATIONS.sessionEvent) continue;
    const event = notification.params.event;
    if (!isRecord(event)) continue;

    const eventUsage = extractEventUsage(event);
    if (eventUsage) {
      usage = addUsage(usage, eventUsage);
      sawMessageUsage = true;
    }
    const streamedUsage = extractChunkUsage(event);
    if (streamedUsage) chunkUsage = addUsage(chunkUsage, streamedUsage);

    const assistantText = extractAssistantText(event);
    if (assistantText) summary = assistantText;

    if (event.type === "tool/call" && isRecord(event.data) && typeof event.data.name === "string") {
      toolName = event.data.name;
    }

    const turnError = extractTurnEndError(event);
    if (turnError) errorMessage = turnError;
  }

  return {
    usage: sawMessageUsage ? usage : chunkUsage,
    summary,
    toolName,
    errorMessage,
    errorFamily: errorMessage ? classifyDeepseekError(errorMessage) : null,
    unknownSession: errorMessage ? isUnknownSessionError(errorMessage) : false,
  };
}

export { isUnknownSessionError };
