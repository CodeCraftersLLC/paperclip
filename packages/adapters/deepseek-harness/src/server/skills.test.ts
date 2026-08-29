import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDeepseekSkills, materializeDeepseekSkills } from "./skills.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deepseek skills", () => {
  it("materializes desired SKILL.md bundles into a custom root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-skills-"));
    tempDirs.push(root);
    const source = path.join(root, "source", "demo-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo\n---\n\nHello.\n",
    );
    const dest = path.join(root, "dest");
    const count = await materializeDeepseekSkills({
      config: {
        paperclipRuntimeSkills: [
          { key: "demo-skill", runtimeName: "demo-skill", source },
        ],
        paperclipSkillSync: { desiredSkills: ["demo-skill"] },
      },
      destDir: dest,
    });
    expect(count).toBe(1);
    const copied = await fs.readFile(path.join(dest, "demo-skill", "SKILL.md"), "utf8");
    expect(copied).toContain("name: demo-skill");
  });

  it("lists Paperclip-managed skills as ephemeral", async () => {
    const snapshot = await listDeepseekSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "deepseek_local",
      config: {},
    });
    expect(snapshot.adapterType).toBe("deepseek_local");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
  });
});
