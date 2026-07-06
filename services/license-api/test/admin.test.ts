import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { LicenseStore } from "../src/store.ts";
import { runAdmin } from "../src/admin.ts";

describe("admin issuance CLI", () => {
  let store: LicenseStore;
  let lines: string[];
  const out = (line: string) => lines.push(line);
  after(() => store?.close());
  beforeEach(() => {
    store?.close();
    store = new LicenseStore(":memory:");
    lines = [];
  });

  function issue(args: string[] = ["--plan", "yearly", "--scope", "private"]): string {
    const code = runAdmin(["issue", ...args], store, out);
    assert.equal(code, 0);
    const keyLine = lines.find((l) => l.includes("key:"));
    assert.ok(keyLine, "issue must print the raw key once");
    const key = keyLine.split("key:")[1].trim();
    assert.ok(key.startsWith("nd_live_"));
    return key;
  }

  it("issue prints the raw key exactly once and stores only the hash", () => {
    const key = issue();
    // The key appears exactly once across all printed lines.
    const occurrences = lines.filter((l) => l.includes(key)).length;
    assert.equal(occurrences, 1);
    const record = store.getLicenseByKey(key);
    assert.ok(record);
    assert.notEqual(record.licenseKeyHash, key);
  });

  it("issue requires --plan and --scope", () => {
    assert.equal(runAdmin(["issue", "--plan", "yearly"], store, out), 2);
    assert.equal(runAdmin(["issue", "--scope", "private"], store, out), 2);
  });

  it("list never prints raw keys", () => {
    const key = issue();
    lines = [];
    assert.equal(runAdmin(["list"], store, out), 0);
    assert.ok(!lines.join("\n").includes(key));
    assert.ok(lines.join("\n").includes(store.getLicenseByKey(key)!.licenseKeyHash));
  });

  it("revoke marks a license revoked; show reflects it without the raw key", () => {
    const key = issue();
    lines = [];
    assert.equal(runAdmin(["revoke", "--key", key, "--reason", "refund"], store, out), 0);
    assert.equal(store.getLicenseByKey(key)!.status, "revoked");
    lines = [];
    assert.equal(runAdmin(["show", "--key", key], store, out), 0);
    const shown = lines.join("\n");
    assert.ok(shown.includes("status=revoked"));
    assert.ok(shown.includes("refund"));
    assert.ok(!shown.includes(key));
  });

  it("revoke and show fail cleanly on an unknown key", () => {
    assert.equal(runAdmin(["revoke", "--key", "nd_live_unknownxxxxxxxxxxxxxxxxxxx"], store, out), 2);
    assert.equal(runAdmin(["show", "--key", "nd_live_unknownxxxxxxxxxxxxxxxxxxx"], store, out), 2);
  });
});
