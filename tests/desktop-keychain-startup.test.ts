import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function swiftBlock(source: string, declaration: string): string {
  const declarationStart = source.indexOf(declaration);
  expect(declarationStart).toBeGreaterThanOrEqual(0);

  const blockStart = source.indexOf("{", declarationStart);
  expect(blockStart).toBeGreaterThan(declarationStart);

  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(declarationStart, index + 1);
  }

  throw new Error(`Unterminated Swift block for ${declaration}`);
}

describe("NeonDiff desktop Keychain startup safety", () => {
  it("uses metadata-only secret presence checks during model initialization", () => {
    const source = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift",
      "utf8"
    );
    const initializer = swiftBlock(source, "init(\n");
    expect(initializer).toContain("containsSecret(");
    expect(initializer).not.toContain("readSecret(");
    expect(initializer).not.toContain("storedDate(");
  });

  it("uses the Security framework's UI-skip policy without constructing LAContext", () => {
    const source = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/KeychainSecretStore.swift",
      "utf8"
    );

    expect(source).not.toContain("import LocalAuthentication");
    expect(source).not.toContain("noninteractiveContext");
    expect(source.match(/kSecUseAuthenticationUISkip/g)).toHaveLength(2);
    expect(source).not.toContain("kSecUseAuthenticationContext");
  });
});
