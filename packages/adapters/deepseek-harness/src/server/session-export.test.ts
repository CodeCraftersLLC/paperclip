import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreDeepseekSessionExport, writeDeepseekSessionExport } from "./session-export.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session export", () => {
  it("round-trips session files and rejects path escape", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sess-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "session.json"), "{\"id\":\"s1\"}\n", "utf8");
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "nested", "log.jsonl"), "event\n", "utf8");
    expect(await writeDeepseekSessionExport(root)).toBe(2);

    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sess-dest-"));
    tempDirs.push(dest);
    const exportBytes = await fs.readFile(path.join(root, ".paperclip-session-export.json"));
    const parsed = JSON.parse(exportBytes.toString("utf8")) as { files: Array<{ path: string; contents: string }> };
    parsed.files.push({ path: "../escape.txt", contents: Buffer.from("nope").toString("base64") });
    const restored = await restoreDeepseekSessionExport({
      localSessionRoot: dest,
      exportBytes: Buffer.from(JSON.stringify(parsed)),
    });
    expect(restored).toBe(2);
    expect(await fs.readFile(path.join(dest, "session.json"), "utf8")).toContain("s1");
    expect(await fs.readFile(path.join(dest, "nested", "log.jsonl"), "utf8")).toBe("event\n");
    await expect(fs.stat(path.join(dest, "..", "escape.txt"))).rejects.toBeDefined();
  });
});
