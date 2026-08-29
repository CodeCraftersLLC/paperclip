import { describe, expect, it } from "vitest";
import { createServerAdapter, type, label } from "./index.js";

describe("createServerAdapter", () => {
  it("exports a hireable deepseek_local module", () => {
    const adapter = createServerAdapter();
    expect(type).toBe("deepseek_local");
    expect(label).toBe("DeepSeek Harness");
    expect(adapter.type).toBe("deepseek_local");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(true);
    expect(adapter.sessionCodec).toBeDefined();
    expect(adapter.getRuntimeCommandSpec?.({})?.installCommand).toBeNull();
    expect(adapter.loginCapability).toBeUndefined();
    expect(adapter.acp).toBeUndefined();
    expect(adapter.listSkills).toBeTypeOf("function");
    expect(adapter.detectModel).toBeTypeOf("function");
  });
});
