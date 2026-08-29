import { describe, expect, it } from "vitest";
import { canResumeDeepseekSession, sessionCodec } from "./session.js";

describe("sessionCodec", () => {
  it("round-trips sessionId, cwd, and sessionRoot", () => {
    const raw = { sessionId: "s1", cwd: "/tmp/ws", sessionRoot: "/tmp/sess" };
    expect(sessionCodec.deserialize(raw)).toEqual(raw);
    expect(sessionCodec.serialize(raw)).toEqual(raw);
    expect(sessionCodec.getDisplayId?.(raw)).toBe("s1");
  });

  it("accepts snake_case aliases", () => {
    expect(sessionCodec.deserialize({ session_id: "s2", session_root: "/r" })).toEqual({
      sessionId: "s2",
      sessionRoot: "/r",
    });
  });

  it("returns null without a session id", () => {
    expect(sessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
  });
});

describe("canResumeDeepseekSession", () => {
  it("resumes when cwd and sessionRoot match", () => {
    expect(
      canResumeDeepseekSession({
        sessionId: "s1",
        savedCwd: "/tmp/ws",
        savedSessionRoot: "/tmp/sess",
        cwd: "/tmp/ws",
        sessionRoot: "/tmp/sess",
      }),
    ).toBe(true);
  });

  it("drops resume on cwd mismatch", () => {
    expect(
      canResumeDeepseekSession({
        sessionId: "s1",
        savedCwd: "/tmp/old",
        savedSessionRoot: "/tmp/sess",
        cwd: "/tmp/new",
        sessionRoot: "/tmp/sess",
      }),
    ).toBe(false);
  });

  it("drops resume on sessionRoot mismatch", () => {
    expect(
      canResumeDeepseekSession({
        sessionId: "s1",
        savedCwd: "/tmp/ws",
        savedSessionRoot: "/tmp/old",
        cwd: "/tmp/ws",
        sessionRoot: "/tmp/new",
      }),
    ).toBe(false);
  });
});
