import { REGRESSION_CATEGORIES } from "./regression-taxonomy.js";

export const REVIEW_FINDINGS_JSON_SCHEMA_NAME = "neondiff_review_findings";
export const REVIEW_FINDINGS_JSON_SCHEMA_STRICT = true;

export interface ReviewFindingsJsonSchema {
  type: "object";
  additionalProperties: false;
  required: ["findings"];
  properties: {
    findings: {
      type: "array";
      items: {
        type: "object";
        additionalProperties: false;
        required: ["severity", "path", "line", "title", "body", "confidence"];
        properties: {
          severity: { type: "string"; enum: ["P0", "P1", "P2", "P3"] };
          path: { type: "string"; minLength: 1 };
          line: { type: "integer"; minimum: 1 };
          title: { type: "string"; minLength: 1 };
          body: { type: "string"; minLength: 1 };
          confidence: { type: "number"; minimum: 0; maximum: 1 };
          category: { type: "string"; enum: typeof REGRESSION_CATEGORIES };
          why_this_matters: { type: "string"; minLength: 1 };
        };
      };
    };
  };
}

export const REVIEW_FINDINGS_JSON_SCHEMA: ReviewFindingsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "path", "line", "title", "body", "confidence"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          path: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          category: { type: "string", enum: REGRESSION_CATEGORIES },
          why_this_matters: { type: "string", minLength: 1 }
        }
      }
    }
  }
};
