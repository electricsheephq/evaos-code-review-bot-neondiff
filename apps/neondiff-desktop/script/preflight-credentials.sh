#!/usr/bin/env bash
set -euo pipefail

# preflight-credentials.sh — desktop signing/notarization/Sparkle credential DOCTOR.
#
# Reports which signing/notarization/appcast-signing credentials are PRESENT,
# MISSING, or INVALID on this machine (or in a CI environment). It is a doctor:
# it mutates nothing, submits nothing, signs nothing, and NEVER prints a secret
# value (only fingerprint tails / identity names where useful for humans).
#
# Exit 0 when every REQUIRED credential is present; non-zero otherwise, listing
# exactly what is missing and the doc pointer to obtain it.
#
# Usage:
#   preflight-credentials.sh            human-readable table (default)
#   preflight-credentials.sh --json     machine-readable JSON
#   preflight-credentials.sh --help
#
# Credential naming/custody policy: apps/neondiff-desktop/docs/signing-credentials.md

# ---------------------------------------------------------------------------
# Configuration — canonical env var / profile names (see signing-credentials.md).
# Overridable so CI can point the doctor at whatever names it injects.
# ---------------------------------------------------------------------------
NOTARY_KEYCHAIN_PROFILE="${NEONDIFF_NOTARY_KEYCHAIN_PROFILE:-neondiff-notary}"
DOCS_POINTER="apps/neondiff-desktop/docs/signing-credentials.md"

MODE="human"
case "${1:-}" in
  --json) MODE="json" ;;
  --help|-h)
    sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [--json|--help]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Result accumulation. Each check appends four parallel arrays:
#   id / status (present|missing|invalid|skipped) / required (true|false) / detail
# ---------------------------------------------------------------------------
IDS=()
STATUSES=()
REQUIREDS=()
DETAILS=()

record() {
  IDS+=("$1")
  STATUSES+=("$2")
  REQUIREDS+=("$3")
  DETAILS+=("$4")
}

# Redact a fingerprint/hash to a short tail so humans can eyeball a match without
# the value being disclosed. "ABCD1234EF..." -> "…34EF".
tail_only() {
  local v="$1"
  local n=${#v}
  if [ "$n" -le 4 ]; then
    printf '…%s' "$v"
  else
    printf '…%s' "${v:$((n-4))}"
  fi
}

# ---------------------------------------------------------------------------
# 1. Developer ID Application certificate (code signing).
# ---------------------------------------------------------------------------
check_developer_id_cert() {
  if ! command -v security >/dev/null 2>&1; then
    record "developer_id_application" "skipped" "true" \
      "'security' tool unavailable (not macOS?); cannot probe codesigning identities"
    return
  fi
  local identities count name
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  # Match "Developer ID Application: Team Name (TEAMID)" lines only.
  count="$(printf '%s\n' "$identities" | grep -c 'Developer ID Application' || true)"
  if [ "${count:-0}" -gt 0 ]; then
    # Extract the identity name (inside quotes) of the first match; never the key.
    name="$(printf '%s\n' "$identities" | grep 'Developer ID Application' | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')"
    record "developer_id_application" "present" "true" \
      "$count Developer ID Application identity/identities (e.g. \"$name\")"
  else
    record "developer_id_application" "missing" "true" \
      "no 'Developer ID Application' identity in keychain — import the Developer ID cert (see $DOCS_POINTER)"
  fi
}

# ---------------------------------------------------------------------------
# 2. Notarization credentials — a notarytool keychain profile OR an ASC API key.
#    We PROBE only; we never submit or fetch history (a dry, read-only check).
# ---------------------------------------------------------------------------
check_notarization() {
  # 2a. App Store Connect API key via env (CI-injected path).
  if [ -n "${NEONDIFF_NOTARY_API_KEY_ID:-}" ] \
     && [ -n "${NEONDIFF_NOTARY_API_ISSUER_ID:-}" ] \
     && [ -n "${NEONDIFF_NOTARY_API_KEY_PATH:-}${NEONDIFF_NOTARY_API_KEY_BASE64:-}" ]; then
    record "notarization" "present" "true" \
      "App Store Connect API key configured via env (key id …$(tail_only "${NEONDIFF_NOTARY_API_KEY_ID}"))"
    return
  fi

  # 2b. notarytool keychain profile (local/owner path).
  if ! command -v xcrun >/dev/null 2>&1; then
    record "notarization" "missing" "true" \
      "no ASC API key env and 'xcrun' unavailable — configure notarytool profile '$NOTARY_KEYCHAIN_PROFILE' or ASC API key (see $DOCS_POINTER)"
    return
  fi

  # `notarytool history` against a profile is read-only and requires no submission.
  # It reaches the network; a stored-but-invalid profile surfaces as an auth error.
  local out rc
  # Guard the assignment: a failing probe must not trip `set -e` before we read $?.
  out="$(xcrun notarytool history --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    record "notarization" "present" "true" \
      "notarytool keychain profile '$NOTARY_KEYCHAIN_PROFILE' is usable"
  elif printf '%s' "$out" | grep -qiE 'could not find|no such|not been found|unable to find|no keychain (item|password item)'; then
    record "notarization" "missing" "true" \
      "no notarytool profile '$NOTARY_KEYCHAIN_PROFILE' and no ASC API key env — create one with 'xcrun notarytool store-credentials' (see $DOCS_POINTER)"
  elif printf '%s' "$out" | grep -qiE 'network|timed out|could not connect|offline'; then
    record "notarization" "skipped" "true" \
      "notarytool profile '$NOTARY_KEYCHAIN_PROFILE' present but could not be verified offline (network probe failed)"
  else
    record "notarization" "invalid" "true" \
      "notarytool profile '$NOTARY_KEYCHAIN_PROFILE' exists but failed to authenticate — rotate/re-store credentials (see $DOCS_POINTER)"
  fi
}

# ---------------------------------------------------------------------------
# 3. Sparkle EdDSA appcast-signing keys.
#    PRIVATE key: custody for signing appcasts (never printed, never committed).
#    PUBLIC key:  goes into Info.plist as SUPublicEDKey (safe to commit/publish).
# ---------------------------------------------------------------------------
check_sparkle_private_key() {
  # Private key custody: env (CI) or Sparkle's generate_keys keychain item (owner).
  if [ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]; then
    record "sparkle_private_key" "present" "true" \
      "appcast signing private key reachable via SPARKLE_ED_PRIVATE_KEY env (value not shown)"
    return
  fi
  # Sparkle stores the generated private key in the login keychain under this name.
  if command -v security >/dev/null 2>&1 \
     && security find-generic-password -s "https://sparkle-project.org" >/dev/null 2>&1; then
    record "sparkle_private_key" "present" "true" \
      "appcast signing private key found in login keychain (Sparkle generate_keys; value not shown)"
    return
  fi
  record "sparkle_private_key" "missing" "true" \
    "no appcast-signing private key (SPARKLE_ED_PRIVATE_KEY env or Sparkle keychain item) — run Sparkle's generate_keys in custody (see $DOCS_POINTER)"
}

check_sparkle_public_key() {
  # Public key config path: the build injects NEONDIFF_SPARKLE_PUBLIC_ED_KEY into
  # Info.plist as SUPublicEDKey (see build_and_run.sh). Safe to disclose, so we
  # only report presence + a redacted tail for eyeballing.
  local pub="${NEONDIFF_SPARKLE_PUBLIC_ED_KEY:-}"
  if [ -n "$pub" ]; then
    record "sparkle_public_key" "present" "false" \
      "SUPublicEDKey configured via NEONDIFF_SPARKLE_PUBLIC_ED_KEY (tail $(tail_only "$pub"))"
  else
    record "sparkle_public_key" "missing" "false" \
      "NEONDIFF_SPARKLE_PUBLIC_ED_KEY unset — the build ships without SUPublicEDKey (Sparkle stays OFF; safe for dev builds; see $DOCS_POINTER)"
  fi
}

# ---------------------------------------------------------------------------
# Run all checks.
# ---------------------------------------------------------------------------
check_developer_id_cert
check_notarization
check_sparkle_private_key
check_sparkle_public_key

# ---------------------------------------------------------------------------
# Compute overall verdict: fail if any REQUIRED credential is missing/invalid.
# ('skipped' does not fail the run — the probe could not be performed here.)
# ---------------------------------------------------------------------------
exit_code=0
missing_ids=()
for i in "${!IDS[@]}"; do
  if [ "${REQUIREDS[$i]}" = "true" ]; then
    case "${STATUSES[$i]}" in
      missing|invalid)
        exit_code=1
        missing_ids+=("${IDS[$i]}")
        ;;
    esac
  fi
done

# ---------------------------------------------------------------------------
# Emit report.
# ---------------------------------------------------------------------------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

if [ "$MODE" = "json" ]; then
  printf '{\n'
  printf '  "ok": %s,\n' "$([ "$exit_code" -eq 0 ] && echo true || echo false)"
  printf '  "checks": [\n'
  for i in "${!IDS[@]}"; do
    printf '    {"id": "%s", "status": "%s", "required": %s, "detail": "%s"}' \
      "$(json_escape "${IDS[$i]}")" \
      "$(json_escape "${STATUSES[$i]}")" \
      "${REQUIREDS[$i]}" \
      "$(json_escape "${DETAILS[$i]}")"
    if [ "$i" -lt $(( ${#IDS[@]} - 1 )) ]; then printf ','; fi
    printf '\n'
  done
  printf '  ],\n'
  printf '  "missing_required": ['
  for j in "${!missing_ids[@]}"; do
    printf '"%s"' "$(json_escape "${missing_ids[$j]}")"
    if [ "$j" -lt $(( ${#missing_ids[@]} - 1 )) ]; then printf ', '; fi
  done
  printf ']\n'
  printf '}\n'
else
  printf 'NeonDiff Desktop — credential preflight doctor\n'
  printf '(reports presence only; signs/notarizes nothing; no secret values printed)\n\n'
  printf '%-26s %-9s %-9s %s\n' "CREDENTIAL" "STATUS" "REQUIRED" "DETAIL"
  printf '%-26s %-9s %-9s %s\n' "--------------------------" "-------" "--------" "------"
  for i in "${!IDS[@]}"; do
    printf '%-26s %-9s %-9s %s\n' \
      "${IDS[$i]}" "${STATUSES[$i]}" "${REQUIREDS[$i]}" "${DETAILS[$i]}"
  done
  printf '\n'
  if [ "$exit_code" -eq 0 ]; then
    printf 'RESULT: all required credentials present.\n'
  else
    printf 'RESULT: missing required credential(s): %s\n' "${missing_ids[*]}"
    printf 'See %s for how to obtain/inject each.\n' "$DOCS_POINTER"
  fi
fi

exit "$exit_code"
