import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PROTOCOL_NOTIFICATIONS } from "./protocol.js";

export type JsonRpcNotification = {
  method: string;
  params: Record<string, unknown>;
};

export type NotificationFilter = (notification: JsonRpcNotification) => boolean;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class JsonRpcResponseError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(error: { code?: number; message?: string; data?: unknown }) {
    super(error.message || `JSON-RPC error ${error.code ?? "unknown"}`);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

type NotificationWaiter = {
  resolve: (notification: JsonRpcNotification) => void;
  reject: (error: Error) => void;
};

export class NotificationSubscription {
  private readonly queue: JsonRpcNotification[] = [];
  private readonly waiters: NotificationWaiter[] = [];
  private failure: Error | null = null;
  private closed = false;

  constructor(
    readonly filter: NotificationFilter | undefined,
    private readonly onClose: () => void,
  ) {}

  push(notification: JsonRpcNotification) {
    if (this.closed || this.failure) return;
    if (this.filter && !this.filter(notification)) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(notification);
    else this.queue.push(notification);
  }

  fail(error: Error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.length = 0;
  }

  close() {
    this.closed = true;
    this.onClose();
  }

  tryNext(): JsonRpcNotification | null {
    if (this.failure) throw this.failure;
    return this.queue.shift() ?? null;
  }

  async next(): Promise<JsonRpcNotification> {
    if (this.failure) throw this.failure;
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.waiters.push({ resolve, reject });
    });
  }
}

export class JsonRpcNdjsonClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Set<NotificationSubscription>();
  private readonly readline: Interface;
  private readonly sessionParents = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
  ) {
    this.readline = createInterface({ input: stdout });
    this.readline.on("line", (line) => this.onLine(line));
    this.readline.on("close", () => {
      this.failTransport(new Error("DeepSeek Harness JSON-RPC stdout closed"));
    });
  }

  failTransport(error: Error) {
    if (this.closed) return;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const subscription of this.subscriptions) subscription.fail(error);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("JSON-RPC client is closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const subscription = new NotificationSubscription(filter, () => {
      this.subscriptions.delete(subscription);
    });
    this.subscriptions.add(subscription);
    return subscription;
  }

  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params;
      if (
        notification.method === PROTOCOL_NOTIFICATIONS.subagentStarted ||
        notification.method === PROTOCOL_NOTIFICATIONS.subagentFinished
      ) {
        const parentId = params.parentSessionId;
        if (typeof parentId === "string" && this.isDescendantOf(parentId, sessionId)) return true;
        return params.childSessionId === sessionId;
      }
      const relatedId = params.sessionId;
      return typeof relatedId === "string" && this.isDescendantOf(relatedId, sessionId);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
    const error = new Error("JSON-RPC client closed");
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const subscription of this.subscriptions) subscription.fail(error);
    this.subscriptions.clear();
  }

  private onLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.id != null && (message.result !== undefined || message.error)) {
      const waiter = this.pending.get(Number(message.id));
      if (!waiter) return;
      this.pending.delete(Number(message.id));
      if (message.error) {
        waiter.reject(new JsonRpcResponseError(message.error as { code?: number; message?: string; data?: unknown }));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    const notification: JsonRpcNotification = {
      method: message.method,
      params: typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>)
        : {},
    };
    this.recordSessionRelationship(notification);
    for (const subscription of this.subscriptions) subscription.push(notification);
  }

  private recordSessionRelationship(notification: JsonRpcNotification) {
    if (notification.method !== PROTOCOL_NOTIFICATIONS.subagentStarted) return;
    const parentId = notification.params.parentSessionId;
    const childId = notification.params.childSessionId;
    if (
      typeof parentId === "string" &&
      parentId &&
      typeof childId === "string" &&
      childId &&
      parentId !== childId
    ) {
      this.sessionParents.set(childId, parentId);
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>();
    let current = sessionId;
    while (current) {
      if (current === rootSessionId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.sessionParents.get(current) ?? "";
    }
    return false;
  }
}
