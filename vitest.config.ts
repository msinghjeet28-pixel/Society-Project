import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * One process, one file at a time.
     *
     * The integration tests share a single Postgres and reset it with TRUNCATE.
     * Any overlap between files lets one file's fixtures vanish under another's
     * reset — which is exactly how CI went red while local stayed green, because
     * timing decided the outcome. singleFork removes the timing from the
     * equation rather than relying on it.
     *
     * Concurrency *inside* a file is untouched: the counter and chain tests
     * depend on it, and it is the behaviour they exist to prove.
     */
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,

    testTimeout: 30_000,
    include: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
