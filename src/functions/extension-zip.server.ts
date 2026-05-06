import JSZip from "jszip";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

async function addDir(zip: JSZip, dir: string, base: string) {
  const entries = await readdir(dir);
  for (const name of entries) {
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      await addDir(zip, full, base);
    } else {
      zip.file(relative(base, full), await readFile(full));
    }
  }
}

export async function buildExtensionZip(): Promise<Uint8Array> {
  const root = join(process.cwd(), "extension");
  const zip = new JSZip();
  await addDir(zip, root, root);
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return new Uint8Array(buf);
}
