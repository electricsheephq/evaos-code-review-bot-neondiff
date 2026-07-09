import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("NeonDiff desktop Keychain startup safety", () => {
  it("uses metadata-only secret presence checks during model initialization", () => {
    const source = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift",
      "utf8"
    );
    const initializerStart = source.indexOf("    init(\n");
    const initializerEnd = source.indexOf("\n    var statusCommand", initializerStart);

    expect(initializerStart).toBeGreaterThanOrEqual(0);
    expect(initializerEnd).toBeGreaterThan(initializerStart);

    const initializer = source.slice(initializerStart, initializerEnd);
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
