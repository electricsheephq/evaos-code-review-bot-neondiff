import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_CREDENTIAL_STDIN_TIMEOUT_MS,
  resolveRuntimeCredentialEnvelope
} from "../src/runtime-github-credentials.js";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
}).privateKey;
const brokerDeviceId = "b".repeat(43);

describe("signed-app credential envelope wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an envelope that arrives after the runner's slow signature check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stdin = new PassThrough();
    const pending = resolveRuntimeCredentialEnvelope({
      command: "daemon",
      runtimeCredentialsStdin: "true",
      stdin
    });
    // The old 5 s wait rejected here; the runner took 95 s on a loaded Mac.
    await vi.advanceTimersByTimeAsync(120_000);
    stdin.end(JSON.stringify({
      schemaVersion: 3,
      githubAppId: "4184532",
      githubPrivateKey: privateKey,
      licenseMachineId: brokerDeviceId
    }));
    await expect(pending).resolves.toMatchObject({ appId: "4184532", licenseMachineId: brokerDeviceId });
  });

  it("still gives up when no envelope ever arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stdin = new PassThrough();
    const pending = resolveRuntimeCredentialEnvelope({
      command: "daemon",
      runtimeCredentialsStdin: "true",
      stdin
    });
    const rejected = expect(pending).rejects.toThrow(/timed out after 300000ms/);
    await vi.advanceTimersByTimeAsync(RUNTIME_CREDENTIAL_STDIN_TIMEOUT_MS + 1);
    await rejected;
  });

  it("fails fast when the runner closes the pipe without an envelope", async () => {
    const stdin = new PassThrough();
    const pending = resolveRuntimeCredentialEnvelope({
      command: "daemon",
      runtimeCredentialsStdin: "true",
      stdin
    });
    stdin.end();
    await expect(pending).rejects.toThrow(/must be non-empty/);
  });
});
