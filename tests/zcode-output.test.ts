import { describe, expect, it } from "vitest";
import { extractJsonObject, extractZCodeResponse } from "../src/zcode.js";

describe("ZCode output parsing", () => {
  it("accepts pretty JSON emitted by current ZCode CLI", () => {
    const stdout = JSON.stringify(
      {
        sessionId: "sess_123",
        response: "```json\n{\"findings\":[]}\n```"
      },
      null,
      2
    );

    expect(extractZCodeResponse(stdout)).toContain("\"findings\":[]");
  });

  it("keeps JSONL compatibility for older ZCode CLI output", () => {
    const stdout = [
      JSON.stringify({ event: "started" }),
      JSON.stringify({ response: "{\"findings\":[]}" })
    ].join("\n");

    expect(extractZCodeResponse(stdout)).toBe("{\"findings\":[]}");
  });

  it("extracts the final review JSON when ZCode adds prose with earlier braces", () => {
    const response = [
      "I checked a callback like `confirmDrop(ctxMenu.item, () => postInvMove(...))` before finalizing.",
      "Here is the result:",
      "{\"findings\":[],\"summary\":\"No validated current-diff findings.\"}"
    ].join("\n\n");

    expect(JSON.parse(extractJsonObject(response))).toEqual({
      findings: [],
      summary: "No validated current-diff findings."
    });
  });
});
