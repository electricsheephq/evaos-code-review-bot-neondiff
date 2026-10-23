import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    // Vitest 4 replacement for `poolOptions.threads.singleThread: true`.
    maxWorkers: 1,
    isolate: false
  }
});
