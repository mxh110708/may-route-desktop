import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const directory = new URL("../../dashboard/src/assets/fonts/", import.meta.url);

function declaredCoverage(value: string): Set<number> {
  const points = new Set<number>();
  for (const range of value.split(",")) {
    const match = /^U\+([A-F0-9]+)(?:-([A-F0-9]+))?$/u.exec(range);
    assert.ok(match);
    const start = parseInt(match[1], 16), end = parseInt(match[2] ?? match[1], 16);
    assert.ok(start <= end && end <= 0x10ffff);
    for (let point = start; point <= end; point++) points.add(point);
  }
  return points;
}

function originalSelectors(font: Buffer): number[] {
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    if (font.toString("ascii", record, record + 4) !== "cmap") continue;
    const cmap = font.readUInt32BE(record + 8);
    for (let table = 0; table < font.readUInt16BE(cmap + 2); table++) {
      const offset = cmap + font.readUInt32BE(cmap + 4 + table * 8 + 4);
      if (font.readUInt16BE(offset) !== 14) continue;
      return Array.from({ length: font.readUInt32BE(offset + 6) }, (_unused, i) => font.readUIntBE(offset + 10 + i * 11, 3));
    }
  }
  return [];
}

function originalCoverage(font: Buffer): Set<number> {
  let cmap = -1;
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    if (font.toString("ascii", record, record + 4) === "cmap") cmap = font.readUInt32BE(record + 8);
  }
  assert.ok(cmap >= 0);
  let format12 = -1;
  for (let index = 0; index < font.readUInt16BE(cmap + 2); index++) {
    const record = cmap + 4 + index * 8;
    const offset = cmap + font.readUInt32BE(record + 4);
    if (font.readUInt16BE(record) === 3 && font.readUInt16BE(record + 2) === 10 && font.readUInt16BE(offset) === 12) format12 = offset;
  }
  assert.ok(format12 >= 0, "the original font must expose full Unicode coverage");
  const result = new Set<number>();
  for (let index = 0; index < font.readUInt32BE(format12 + 12); index++) {
    const record = format12 + 16 + index * 12;
    const start = font.readUInt32BE(record), end = font.readUInt32BE(record + 4), glyph = font.readUInt32BE(record + 8);
    for (let point = start; point <= end; point++) if (glyph + point - start !== 0) result.add(point);
  }
  return result;
}

test("bundled ranges preserve the original complete Unicode coverage and verified assets", async () => {
  const source = await readFile(new URL("LXGWWenKai-Regular.ttf", directory));
  const manifest = JSON.parse(await readFile(new URL("wenkai/manifest.json", directory), "utf8"));
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256(source), manifest.sourceSha256);
  const covered = new Set<number>();
  const sourceCoverage = originalCoverage(source);
  const definitions = await readFile(new URL("wenkai/parts.ts", directory), "utf8");
  const runtimeRanges = [...definitions.matchAll(/unicodeRange: "([^"]+)", common: (true|false)/gu)];
  assert.equal(runtimeRanges.length, manifest.parts.length);
  let common = 0;
  for (const [index, part] of manifest.parts.entries()) {
    assert.match(part.file, /^(?:common|korean|cjk-[a-f0-9]+)\.woff2$/u);
    const bytes = await readFile(new URL("wenkai/" + part.file, directory));
    assert.equal(bytes.toString("ascii", 0, 4), "wOF2");
    assert.equal(bytes.length, part.bytes);
    assert.equal(sha256(bytes), part.sha256);
    const points = declaredCoverage(part.unicodeRange);
    for (const point of points) {
      assert.equal(covered.has(point), false, "each character belongs to one range");
      covered.add(point);
    }
    assert.equal(points.size, part.characters);
    const runtime = new Set(points);
    if (part.common) {
      for (const selector of originalSelectors(source)) runtime.add(selector);
      for (const point of points) for (const char of String.fromCodePoint(point).normalize("NFD")) {
        const input = char.codePointAt(0)!;
        if (!sourceCoverage.has(input)) runtime.add(input);
      }
    }
    assert.deepEqual(declaredCoverage(runtimeRanges[index][1]), runtime, "runtime font ranges must agree with the manifest");
    assert.equal(runtimeRanges[index][2] === "true", part.common);
    if (part.common) common++;
  }
  assert.equal(common, 1);
  assert.equal(covered.size, manifest.characters);
  assert.deepEqual(covered, sourceCoverage);
});
