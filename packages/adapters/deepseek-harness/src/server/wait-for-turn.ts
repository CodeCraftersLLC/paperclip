import {
  PROTOCOL_NOTIFICATIONS,
  isInboxReceipt,
  isRecord,
} from "./protocol.js";
import type { JsonRpcNotification, NotificationSubscription } from "./jsonrpc-client.js";

export interface WaitForTurnOptions {
  sessionId: string;
  messageId: string;
  timeoutMs: number;
  onNotification?: (notification: JsonRpcNotification) => void | Promise<void>;
}

export async function waitForPromptTurn(
  subscription: NotificationSubscription,
  options: WaitForTurnOptions,
): Promise<JsonRpcNotification[]> {
  const collected: JsonRpcNotification[] = [];
  let received = false;
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(timeoutMessage(received, options.messageId));
    }

    const notification = await nextWithTimeout(
      subscription,
      remaining,
      timeoutMessage(received, options.messageId),
    );

    if (!received) {
      if (
        notification.method !== PROTOCOL_NOTIFICATIONS.sessionEvent ||
        notification.params.sessionId !== options.sessionId ||
        !isInboxReceipt(notification.params.event, options.messageId)
      ) {
        continue;
      }
      received = true;
    }

    collected.push(notification);
    await options.onNotification?.(notification);

    if (
      notification.method === PROTOCOL_NOTIFICATIONS.sessionStatus &&
      notification.params.sessionId === options.sessionId &&
      notification.params.status === "idle"
    ) {
      return collected;
    }
  }
}

export function notificationEventType(notification: JsonRpcNotification): string | null {
  if (notification.method !== PROTOCOL_NOTIFICATIONS.sessionEvent) return notification.method;
  const event = notification.params.event;
  return isRecord(event) && typeof event.type === "string" ? event.type : null;
}

function timeoutMessage(received: boolean, messageId: string): string {
  return received
    ? `timed out waiting for session.status idle after inbox receipt ${messageId}`
    : `timed out waiting for agent/inbox/spliced receipt ${messageId}`;
}

async function nextWithTimeout(
  subscription: NotificationSubscription,
  timeoutMs: number,
  timeoutMessageText: string,
): Promise<JsonRpcNotification> {
  const queued = subscription.tryNext();
  if (queued) return queued;

  let timer: NodeJS.Timeout | undefined;
  const nextPromise = subscription.next();
  try {
    return await Promise.race([
      nextPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessageText)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void nextPromise.catch(() => {});
  }
}
