import { LicenseStore } from "../../src/store.ts";

const dbPath = process.env.CHECKOUT_BINDING_DB_PATH;
const inputJson = process.env.CHECKOUT_BINDING_INPUT;
if (!dbPath || !inputJson || !process.send) {
  throw new Error("checkout binding worker configuration is missing");
}
const input = JSON.parse(inputJson);
const store = new LicenseStore(dbPath, { busyTimeoutMs: 1_000 });
let storeClosed = false;

function closeStore(): void {
  if (storeClosed) return;
  storeClosed = true;
  store.close();
}

process.send({ type: "ready", storeOpened: true });

process.once("message", (message: unknown) => {
  if (message !== "GO") {
    process.send?.({ type: "protocol_error" });
    closeStore();
    process.disconnect();
    return;
  }
  try {
    const result = store.bindCheckoutSubscription(input);
    process.send?.({ type: "result", result: result.result });
  } catch (error) {
    process.send?.({
      type: "error",
      errorName: error instanceof Error ? error.constructor.name : "UnknownError"
    });
  } finally {
    closeStore();
    process.disconnect();
  }
});

process.once("disconnect", closeStore);
