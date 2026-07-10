import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

  it("rejects unsafe byte limits before attaching stream listeners", async () => {
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      const stream = new PassThrough();
      await expect(readSecretFromStdin(stream, limit, 25)).rejects.toThrow(
        "maxBytes must be a positive safe integer"
      );
      expect(stream.listenerCount("data")).toBe(0);
      expect(stream.listenerCount("end")).toBe(0);
      expect(stream.listenerCount("error")).toBe(0);
      expect(stream.destroyed).toBe(false);
    }
  });

  it("rejects an interactive TTY immediately without attaching stream listeners", async () => {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
    stream.isTTY = true;
    const baseline = {
      data: stream.listenerCount("data"),
      end: stream.listenerCount("end"),
      error: stream.listenerCount("error")
    };

    await expect(readSecretFromStdin(stream, 64, 25)).rejects.toThrow(
      "provider secret stdin must be piped"
    );

    expect(stream.listenerCount("data")).toBe(baseline.data);
    expect(stream.listenerCount("end")).toBe(baseline.end);
    expect(stream.listenerCount("error")).toBe(baseline.error);
    expect(stream.destroyed).toBe(false);
  });

  it("times out an abandoned owned pipe, clears listeners, and closes the stream without echoing buffered input", async () => {
    const stream = new PassThrough();
    const fixtureSecret = "fixture-provider-value";

    const pending = readSecretFromStdin(stream, 64, 10);
    stream.write(fixtureSecret);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("timed out");
    expect((failure as Error).message).not.toContain(fixtureSecret);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.destroyed).toBe(true);
  });

  it("rejects a stream with an existing consumer without changing its lifecycle", async () => {
    const stream = new PassThrough();
    const existingDataListener = () => undefined;
    stream.on("data", existingDataListener);

    await expect(readSecretFromStdin(stream, 64, 10)).rejects.toThrow("existing consumer");

    expect(stream.listeners("data")).toContain(existingDataListener);
    expect(stream.destroyed).toBe(false);

    stream.off("data", existingDataListener);
    stream.end();
  });

  it("does not take ownership of an already-flowing stream", async () => {
    const stream = new PassThrough();
    stream.resume();

    await expect(readSecretFromStdin(stream, 64, 10)).rejects.toThrow("existing consumer");

    expect(stream.readableFlowing).toBe(true);
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });

  it("does not emit a later transport error after timeout closes an owned stream", async () => {
    const stream = new PassThrough();
    let laterErrorEvents = 0;
    stream.on("error", () => {
      laterErrorEvents += 1;
    });

    await expect(readSecretFromStdin(stream, 64, 10)).rejects.toThrow("timed out");
    expect(stream.destroyed).toBe(true);

    stream.destroy(new Error("late transport failure with fixture-provider-value"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(laterErrorEvents).toBe(0);
  });

  it("clears the deadline after successful EOF", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const pending = readSecretFromStdin(stream, 64, 20);
      stream.end("fixture-provider-value\n");

      await expect(pending).resolves.toBe("fixture-provider-value");

      expect(vi.getTimerCount()).toBe(0);
      expect(stream.listenerCount("data")).toBe(0);
      expect(stream.listenerCount("end")).toBe(0);
      expect(stream.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
