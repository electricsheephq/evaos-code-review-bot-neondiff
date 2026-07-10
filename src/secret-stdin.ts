export async function readSecretFromStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = 64 * 1024,
  timeoutMs = 5_000
): Promise<string> {
  if ((stream as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true) {
    throw new Error("provider secret stdin must be piped; interactive TTY input is not supported");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("provider secret stdin timeout must be a positive number");
  }
  if (
    stream.listenerCount("data") > 0 ||
    stream.listenerCount("readable") > 0 ||
    (stream as NodeJS.ReadableStream & { readableFlowing?: boolean | null }).readableFlowing === true
  ) {
    throw new Error("provider secret stdin already has an existing consumer");
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;

    const clearBufferedSecret = (): void => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const cleanup = (): void => {
      clearTimeout(deadline);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const closeOwnedStream = (): void => {
      const ownedStream = stream as NodeJS.ReadableStream & {
        destroyed?: boolean;
        destroy?: () => void;
      };
      if (typeof ownedStream.destroy === "function") {
        if (ownedStream.destroyed !== true) ownedStream.destroy();
        return;
      }
      stream.pause();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearBufferedSecret();
      closeOwnedStream();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        buffer.fill(0);
        fail(new Error(`provider secret stdin exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const combined = Buffer.concat(chunks);
      clearBufferedSecret();
      const secret = combined.toString("utf8").trim();
      combined.fill(0);
      if (!secret) {
        reject(new Error("provider secret stdin must be non-empty"));
        return;
      }
      resolve(secret);
    };
    const onError = (): void => {
      fail(new Error("provider secret stdin could not be read"));
    };

    deadline = setTimeout(() => {
      fail(new Error(`provider secret stdin timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.on("data", onData);
  });
}
