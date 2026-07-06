import { LicenseStore } from "./store.js";
import { startLicenseServer } from "./http.js";

/**
 * Production entrypoint. SQLite lives on a mounted volume in deploy
 * (LICENSE_DB_PATH); PORT/HOST come from the platform. TLS is terminated by
 * fly, so the process serves plain HTTP on the internal port.
 */
async function main(): Promise<void> {
  const dbPath = process.env.LICENSE_DB_PATH ?? "runtime/license.sqlite";
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const store = new LicenseStore(dbPath);
  const { url } = await startLicenseServer({ store, port, host });
  // eslint-disable-next-line no-console
  console.log(`license-api listening on ${url} (db=${dbPath})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`license-api failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
