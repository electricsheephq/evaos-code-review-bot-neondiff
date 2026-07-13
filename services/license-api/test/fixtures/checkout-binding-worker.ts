import { LicenseStore } from "../../src/store.ts";

const dbPath = process.env.CHECKOUT_BINDING_DB_PATH;
const inputJson = process.env.CHECKOUT_BINDING_INPUT;
if (!dbPath || !inputJson || !process.send) {
  throw new Error("checkout binding worker configuration is missing");
}

process.send({ type: "ready" });

process.once("message", (message: unknown) => {
  if (message !== "GO") {
    process.send?.({ type: "protocol_error" });
    process.disconnect();
    return;
  }
  const store = new LicenseStore(dbPath, { busyTimeoutMs: 1_000 });
  try {
    const result = store.bindCheckoutSubscription(JSON.parse(inputJson));
    process.send?.({ type: "result", result: result.result });
  } catch (error) {
    process.send?.({
      type: "error",
      errorName: error instanceof Error ? error.constructor.name : "UnknownError"
    });
  } finally {
    store.close();
    process.disconnect();
  }
});
