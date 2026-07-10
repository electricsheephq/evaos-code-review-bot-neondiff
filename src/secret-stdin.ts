export async function readSecretFromStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = 64 * 1024
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) throw new Error(`provider secret stdin exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) throw new Error("provider secret stdin must be non-empty");
  return secret;
}
