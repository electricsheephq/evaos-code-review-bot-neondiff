import { existsSync } from "node:fs";
import { join } from "node:path";

export function assertSwiftCorpusBoundary(root) {
  const swiftTestCorpus = join(
    root,
    "apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/Support/CanonicalSecretRuleCorpus.generated.swift"
  );
  const retiredSwiftCorpus = join(
    root,
    "apps/neondiff-desktop/Sources",
    ["NeonDiffDesktopCore", "Checks"].join(""),
    "CanonicalSecretRuleCorpus.generated.swift"
  );
  if (!existsSync(swiftTestCorpus)) {
    throw new Error("generated Swift test corpus is missing from the compiled Core test target");
  }
  if (existsSync(retiredSwiftCorpus)) {
    throw new Error("generated Swift test corpus still has an orphan copy under Sources");
  }
}
