import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    // Vitest 4 removed poolOptions. One worker keeps the old single-thread ordering; isolation stays
    // on because v3's singleThread still re-evaluated source modules per file, which vi.mock relies on.
    maxWorkers: 1
  }
});
