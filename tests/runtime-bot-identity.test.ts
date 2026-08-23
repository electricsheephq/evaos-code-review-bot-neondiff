import { describe, expect, it } from "vitest";
import { deriveCanonicalBotLogin, isBotAuthoredComment } from "../src/runtime-bot-identity.js";

describe("runtime bot identity", () => {
  it("derives a case-normalized login from an authoritative App slug", () => {
    expect(deriveCanonicalBotLogin({ appSlug: "Customer-Review-App" })).toBe("customer-review-app[bot]");
    expect(isBotAuthoredComment({ user: { login: "CUSTOMER-REVIEW-APP[BOT]", type: "Bot" } }, "customer-review-app[bot]")).toBe(true);
  });

  it("accepts an explicit verified login only when it agrees with the App slug", () => {
    expect(deriveCanonicalBotLogin({ appSlug: "customer-review-app", verifiedBotLogin: "CUSTOMER-REVIEW-APP[BOT]" })).toBe("customer-review-app[bot]");
    expect(deriveCanonicalBotLogin({ appSlug: "customer-review-app", verifiedBotLogin: "other-review-app[bot]" })).toBeUndefined();
  });

  it("fails closed for missing or malformed proof and non-bot authors", () => {
    expect(deriveCanonicalBotLogin({})).toBeUndefined();
    expect(deriveCanonicalBotLogin({ appSlug: "customer_review_app" })).toBeUndefined();
    expect(isBotAuthoredComment({ user: { login: "customer-review-app[bot]", type: "User" } }, "customer-review-app[bot]")).toBe(false);
    expect(isBotAuthoredComment({ user: { login: "customer-review-app[bot]", type: "Bot" } }, undefined)).toBe(false);
  });
});
