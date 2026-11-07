// Synthetic examples plus the local Node 26.12.1 / undici 8.12.2 probe shapes.
export const fetchErrorMessages = [
  ["fetch failed; cause=SocketError: other side closed", "code=UND_ERR_SOCKET"],
  ["fetch failed; cause=Error: Request was cancelled.", "AbortError: The operation was aborted."],
  ["fetch failed; cause=AggregateError: ", "errors(0)=Error: connect ETIMEDOUT 192.0.2.1:443 (code=ETIMEDOUT); errors(1)=Error: connect ENETUNREACH (code=ENETUNREACH)"],
  ["fetch failed; cause=Error: read ECONNRESET", "code=ECONNRESET"],
  ["fetch failed; cause=Error: connect ECONNREFUSED 127.0.0.1:12345", "code=ECONNREFUSED"],
  ["terminated; cause=ResponseContentLengthMismatchError: Response body length does not match content-length header", "code=UND_ERR_RES_CONTENT_LENGTH_MISMATCH"],
  ["fetch failed; cause=Error: Request was cancelled.", "Error: provider_code=1302; providerRequestId: 'fixture-request'; retry_after_ms=9000; zcode_model_output_schema_failure"]
].map(([base, detail]) => ({ base, full: `${base} [cause-chain: ${detail}]` }));
