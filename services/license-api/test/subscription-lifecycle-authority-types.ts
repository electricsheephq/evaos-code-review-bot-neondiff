import type { ParsedSubscriptionLifecycleRequest } from "../src/subscription-lifecycle.js";

declare const request: ParsedSubscriptionLifecycleRequest;

if (request.command === "renew_paid" || request.command === "cancel_at_period_end") {
  const authoritativePeriod: string = request.currentPeriodEnd;
  void authoritativePeriod;
  // @ts-expect-error Diagnostic periods are not present on authoritative commands.
  request.diagnosticCurrentPeriodEnd;
}

if (request.command === "reconcile" || request.command === "payment_attention") {
  const diagnosticPeriod: string | undefined = request.diagnosticCurrentPeriodEnd;
  void diagnosticPeriod;
  // @ts-expect-error Diagnostic commands cannot expose an authoritative period.
  request.currentPeriodEnd;
}

if (request.command === "revoke") {
  // @ts-expect-error Revocation cannot carry an authoritative period.
  request.currentPeriodEnd;
  // @ts-expect-error Revocation cannot carry a diagnostic period.
  request.diagnosticCurrentPeriodEnd;
}
