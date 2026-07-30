import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one Postgres; running files in parallel would
    // interleave their fixtures. Concurrency inside a file is the point of the
    // counter and chain tests, so that stays.
    fileParallelism: false,
    testTimeout: 30_000,
    include: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
