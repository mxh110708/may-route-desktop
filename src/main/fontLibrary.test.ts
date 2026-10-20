import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FontLibrary, validateFont, MAX_FONT_BYTES } from "./fontLibrary";

test("font parser rejects spoofed formats, truncation and oversized data", () => {
  for (const data of [Buffer.from("MZnot-a-font"), Buffer.alloc(12), Buffer.alloc(MAX_FONT_BYTES + 1)]) assert.throws(() => validateFont(data));
});
test("font import preserves bytes, reuses duplicates and rejects tampering or path traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "may-font-test-"));
  try {
    const bytes = await readFile(new URL("../../dashboard/src/assets/fonts/LXGWWenKai-Regular.ttf", import.meta.url));
    const path = join(directory, "example.ttf"); await writeFile(path, bytes);
    const library = new FontLibrary(join(directory, "library"));
    const imported = await library.import(path);
    assert.equal(imported.name, "example");
    assert.deepEqual(Buffer.from(await library.data(imported.id)), bytes);
    assert.deepEqual(await library.import(path), imported);
    assert.equal((await library.list()).length, 1);
    await assert.rejects(library.data("../example.ttf"));
    await writeFile(join(directory, "library", imported.id + ".ttf"), Buffer.from("damaged"));
    await assert.rejects(library.data(imported.id));
    assert.equal((await readdir(join(directory, "library"))).length, 2);
    const damaged = Buffer.from(bytes); damaged.writeUInt32BE(0xffffffff, 20);
    assert.throws(() => validateFont(damaged));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
