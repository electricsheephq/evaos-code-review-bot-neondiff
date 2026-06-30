import { describe, expect, it } from "vitest";
import { extractZCodeResponse } from "../src/zcode.js";

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
});
