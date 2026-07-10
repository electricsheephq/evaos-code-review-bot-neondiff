import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecretFromStdin } from "../src/secret-stdin.js";

describe("readSecretFromStdin", () => {
  it("reads one trimmed secret without echoing it", async () => {
    await expect(readSecretFromStdin(Readable.from(["fixture-provider-value\n"]), 64))
      .resolves.toBe("fixture-provider-value");
  });

  it("rejects empty and oversized stdin", async () => {
    await expect(readSecretFromStdin(Readable.from(["\n"]), 64)).rejects.toThrow("non-empty");
    await expect(readSecretFromStdin(Readable.from(["x".repeat(65)]), 64)).rejects.toThrow("64 bytes");
  });
});
