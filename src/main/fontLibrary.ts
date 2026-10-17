import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const MAX_FONT_BYTES = 32 * 1024 * 1024;
export interface InterfaceFont { id: string; name: string }
const FONT_ID = /^font-[a-f0-9]{64}$/u;

export function validateFont(data: Uint8Array): ".ttf" | ".otf" {
  const bytes = Buffer.from(data);
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) throw new Error("Font must be a TTF/OTF file of at most 32 MiB.");
  const kind = bytes.readUInt32BE(0);
  if (kind !== 0x00010000 && kind !== 0x4f54544f) throw new Error("Unsupported font format. Choose a TTF or OTF file.");
  const count = bytes.readUInt16BE(4);
  if (count < 1 || count > 512 || 12 + count * 16 > bytes.length) throw new Error("Invalid font table directory.");
  const tables = new Set<string>();
  for (let index = 0; index < count; index++) {
    const position = 12 + index * 16;
    const tag = bytes.toString("ascii", position, position + 4);
    const offset = bytes.readUInt32BE(position + 8);
    const length = bytes.readUInt32BE(position + 12);
    if (tables.has(tag) || offset < 12 + count * 16 || offset + length > bytes.length) throw new Error("Invalid font table bounds.");
    tables.add(tag);
  }
  if (!["head", "name", "cmap", "hhea", "hmtx", "maxp"].every((tag) => tables.has(tag)) ||
      !(tables.has("glyf") || tables.has("CFF ") || tables.has("CFF2"))) throw new Error("Font contains no supported outline tables.");
  return kind === 0x00010000 ? ".ttf" : ".otf";
}

async function readBounded(path: string, maximum = MAX_FONT_BYTES): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error("Font file is missing, linked or too large.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > maximum) throw new Error("Font file changed while opening.");
    const data = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < data.length) {
      const { bytesRead } = await handle.read(data, total, data.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) throw new Error("Font file changed while reading.");
    return data.subarray(0, total);
  } finally { await handle.close(); }
}

export class FontLibrary {
  constructor(private readonly directory: string) {}

  private async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Font directory must be a local directory.");
  }

  private async metadata(id: string): Promise<InterfaceFont & { extension: string }> {
    if (!FONT_ID.test(id)) throw new Error("Invalid imported font ID.");
    const value: unknown = JSON.parse((await readBounded(join(this.directory, id + ".json"), 2048)).toString("utf8"));
    const entry = value as Record<string, unknown> | null;
    if (!entry || entry.id !== id || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 100 ||
        (entry.extension !== ".ttf" && entry.extension !== ".otf")) throw new Error("Invalid imported font record.");
    return { id, name: entry.name, extension: entry.extension };
  }

  async list(): Promise<InterfaceFont[]> {
    await this.ensureDirectory();
    const names = await readdir(this.directory);
    const result: InterfaceFont[] = [];
    for (const name of names.filter((name) => /^font-[a-f0-9]{64}\.json$/u.test(name)).slice(0, 32)) {
      try { const entry = await this.metadata(name.slice(0, -5)); result.push({ id: entry.id, name: entry.name }); }
      catch { /* A damaged record must not prevent selecting a built-in font. */ }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async data(id: string): Promise<Uint8Array> {
    await this.ensureDirectory();
    const entry = await this.metadata(id);
    const data = await readBounded(join(this.directory, id + entry.extension));
    if (validateFont(data) !== entry.extension || "font-" + createHash("sha256").update(data).digest("hex") !== id) throw new Error("Imported font checksum mismatch. Import the font again.");
    return new Uint8Array(data);
  }

  async import(path: string): Promise<InterfaceFont> {
    await this.ensureDirectory();
    if (![".ttf", ".otf"].includes(extname(path).toLowerCase())) throw new Error("Choose a TTF or OTF font.");
    const data = await readBounded(path);
    const extension = validateFont(data);
    const id = "font-" + createHash("sha256").update(data).digest("hex");
    const existing = (await this.list()).find((font) => font.id === id);
    if (existing) { await this.data(id); return existing; }
    if ((await this.list()).length >= 32) throw new Error("The font library already contains 32 imported fonts.");
    const name = basename(path, extname(path)).replace(/[\u0000-\u001f]/gu, "").trim().slice(0, 100) || "Imported font";
    const target = join(this.directory, id + extension);
    try { await writeFile(target, data, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readBounded(target)).equals(data)) throw error;
    }
    const metadata = join(this.directory, id + ".json");
    try { await writeFile(metadata, JSON.stringify({ id, name, extension }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const saved = await this.metadata(id);
    return { id, name: saved.name };
  }
}
