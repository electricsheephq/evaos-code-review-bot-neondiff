import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const helper = fileURLToPath(new URL("../helpers/descriptor_tree.py", import.meta.url));
const maximumOutputBytes = 768 * 1024 * 1024;

export function walkDescriptorTree(root, visitor) {
  let output;
  try {
    output = execFileSync(
      "/usr/bin/python3",
      [helper, "--root", resolve(root)],
      { encoding: "utf8", maxBuffer: maximumOutputBytes }
    );
  } catch {
    throw new Error("descriptor-relative tree traversal failed");
  }
  for (const line of output.split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (entry.type === "file") {
      visitor({
        type: "file",
        relativePath: entry.relativePath,
        data: Buffer.from(entry.dataBase64, "base64"),
        stat: { size: entry.size, mode: entry.mode }
      });
    } else if (entry.type === "directory") {
      visitor({ type: "directory", relativePath: entry.relativePath });
    } else if (entry.type === "symlink") {
      visitor({ type: "symlink", relativePath: entry.relativePath, target: entry.target });
    } else {
      throw new Error("descriptor-relative tree traversal returned an invalid entry");
    }
  }
}
