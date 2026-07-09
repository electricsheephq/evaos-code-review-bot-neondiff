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
        required: Array<"severity" | "path" | "line" | "title" | "body" | "confidence" | "category" | "why_this_matters">;
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

export const STRICT_REVIEW_FINDINGS_JSON_SCHEMA: ReviewFindingsJsonSchema = {
  ...REVIEW_FINDINGS_JSON_SCHEMA,
  properties: {
    findings: {
      ...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings,
      items: {
        ...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items,
        required: [
          "severity",
          "path",
          "line",
          "title",
          "body",
          "confidence",
          "category",
          "why_this_matters"
        ]
      }
    }
  }
};

const ANTHROPIC_UNSUPPORTED_SCHEMA_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties"
]);

export function anthropicStructuredOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => anthropicStructuredOutputSchema(entry));
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !ANTHROPIC_UNSUPPORTED_SCHEMA_CONSTRAINTS.has(key))
      .map(([key, value]) => [key, anthropicStructuredOutputSchema(value)])
  );
}

export const ANTHROPIC_REVIEW_FINDINGS_JSON_SCHEMA = anthropicStructuredOutputSchema(STRICT_REVIEW_FINDINGS_JSON_SCHEMA);
