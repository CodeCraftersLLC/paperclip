import fs from "node:fs/promises";
import path from "node:path";

export const SESSION_EXPORT_FILENAME = ".paperclip-session-export.json";

export interface DeepseekSessionExportFile {
  path: string;
  contents: string;
}

export async function writeDeepseekSessionExport(sessionRoot: string): Promise<number> {
  const root = path.resolve(sessionRoot);
  const files: DeepseekSessionExportFile[] = [];
  await walkSessionFiles(root, "", files);
  await fs.writeFile(path.join(root, SESSION_EXPORT_FILENAME), JSON.stringify({ files }), "utf8");
  return files.length;
}

export async function restoreDeepseekSessionExport(input: {
  localSessionRoot: string;
  exportBytes: Buffer;
}): Promise<number> {
  const root = path.resolve(input.localSessionRoot);
  await fs.mkdir(root, { recursive: true });
  const parsed = JSON.parse(input.exportBytes.toString("utf8")) as { files?: unknown };
  if (!Array.isArray(parsed.files)) return 0;
  let count = 0;
  for (const entry of parsed.files) {
    if (!entry || typeof entry !== "object") continue;
    const relative = typeof (entry as DeepseekSessionExportFile).path === "string"
      ? (entry as DeepseekSessionExportFile).path
      : "";
    const contents = typeof (entry as DeepseekSessionExportFile).contents === "string"
      ? (entry as DeepseekSessionExportFile).contents
      : "";
    if (!relative || relative.includes("\0") || path.isAbsolute(relative)) continue;
    const dest = path.resolve(root, relative);
    const contained = dest === root || dest.startsWith(`${root}${path.sep}`);
    if (!contained) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(contents, "base64"));
    count += 1;
  }
  return count;
}

async function walkSessionFiles(
  dir: string,
  relative: string,
  files: DeepseekSessionExportFile[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === SESSION_EXPORT_FILENAME) continue;
    const nextRel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSessionFiles(full, nextRel, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      path: nextRel,
      contents: (await fs.readFile(full)).toString("base64"),
    });
  }
}
