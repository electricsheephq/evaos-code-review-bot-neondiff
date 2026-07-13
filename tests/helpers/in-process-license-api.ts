import { createLicenseRequestListener } from "../../services/license-api/src/http.js";
import { RateLimiter } from "../../services/license-api/src/service.js";
import { LicenseStore } from "../../services/license-api/src/store.js";

export interface InProcessLicenseApi {
  fetchImpl: typeof fetch;
  store: LicenseStore;
  close(): void;
}

export function createInProcessLicenseApi(issuanceSecret: string): InProcessLicenseApi {
  const now = () => new Date("2026-07-13T00:00:00.000Z");
  const store = new LicenseStore(":memory:", { now });
  const listener = createLicenseRequestListener({
    store,
    issuanceSecret,
    now,
    rateLimiter: new RateLimiter({ maxPerWindow: 1_000, windowMs: 60_000 })
  });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = String(init?.body ?? "");
    return await new Promise<Response>((resolve, reject) => {
      let requestErrorCallback: ((error: Error) => void) | undefined;
      const req: any = {
        method: init?.method ?? "POST",
        url: path,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        socket: { remoteAddress: "127.0.0.1" },
        on(event: string, callback: (value?: unknown) => void) {
          if (event === "data" && body) callback(Buffer.from(body));
          if (event === "end") callback();
          if (event === "error") {
            requestErrorCallback = callback as (error: Error) => void;
          }
          return req;
        },
        destroy(error?: Error) {
          if (!error) return;
          if (requestErrorCallback) {
            try {
              requestErrorCallback(error);
            } catch (callbackError) {
              reject(callbackError);
            }
          } else {
            reject(error);
          }
        }
      };
      let statusCode = 200;
      let responseHeaders: Record<string, string> = {};
      const responseChunks: string[] = [];
      const res: any = {
        writeHead(code: number, headers: Record<string, string>) {
          statusCode = code;
          responseHeaders = headers;
          return res;
        },
        end(payload?: string) {
          if (payload) responseChunks.push(payload);
          resolve(new Response(responseChunks.join(""), {
            status: statusCode,
            headers: responseHeaders
          }));
        }
      };
      void listener(req, res).catch(reject);
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    store,
    close: () => store.close()
  };
}
