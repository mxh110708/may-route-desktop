import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(root, "resources/upstream-icons.json"), "utf8"),
) as {
  repository: string;
  commit: string;
  files: Record<string, string>;
};
if (
  manifest.repository !== "SagerNet/sing-box-for-desktop" ||
  !/^[a-f0-9]{40}$/u.test(manifest.commit)
) {
  throw new Error("invalid upstream icon provenance");
}
for (const [relative, expected] of Object.entries(manifest.files)) {
  if (
    !/^resources\/(?:icons\/)?[a-zA-Z0-9@.]+\.(?:ico|png)$/u.test(relative) ||
    !/^[a-f0-9]{64}$/u.test(expected)
  ) {
    throw new Error("invalid upstream icon entry");
  }
  const digest = createHash("sha256")
    .update(readFileSync(path.join(root, relative)))
    .digest("hex");
  if (digest !== expected) {
    throw new Error(`upstream icon asset was modified: ${relative}`);
  }
}
console.info(
  `Verified ${Object.keys(manifest.files).length} unchanged upstream desktop icon files.`,
);
