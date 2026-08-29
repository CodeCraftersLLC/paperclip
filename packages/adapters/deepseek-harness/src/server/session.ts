import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface DeepseekSessionParams {
  sessionId: string;
  cwd?: string;
  sessionRoot?: string;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const sessionRoot =
      readNonEmptyString(record.sessionRoot) ??
      readNonEmptyString(record.session_root);
    const remoteExecution =
      typeof record.remoteExecution === "object" &&
      record.remoteExecution !== null &&
      !Array.isArray(record.remoteExecution)
        ? record.remoteExecution
        : null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(sessionRoot ? { sessionRoot } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return sessionCodec.deserialize(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

export function canResumeDeepseekSession(input: {
  sessionId: string | null;
  savedCwd: string | null;
  savedSessionRoot: string | null;
  cwd: string;
  sessionRoot: string;
}): boolean {
  if (!input.sessionId) return false;
  if (input.savedCwd && resolveComparable(input.savedCwd) !== resolveComparable(input.cwd)) {
    return false;
  }
  if (
    input.savedSessionRoot &&
    resolveComparable(input.savedSessionRoot) !== resolveComparable(input.sessionRoot)
  ) {
    return false;
  }
  return true;
}

function resolveComparable(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}
