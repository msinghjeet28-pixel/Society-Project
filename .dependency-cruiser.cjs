/**
 * GUARDRAIL for Tech Design §01 — module boundaries, executable.
 * `pnpm depcruise` exits non-zero on violation; CI blocks the merge.
 */
module.exports = {
  forbidden: [
    {
      name: "no-app-to-app",
      severity: "error",
      comment:
        "Apps must not import each other. The only legitimate cross-app path is api → worker " +
        "via the job queue, which is a declared interface, not an import.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/(?!$1)([^/]+)/" },
    },
    {
      name: "packages-stay-independent",
      severity: "error",
      comment: "Shared packages may not reach into apps — that inverts the dependency direction.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "mobile-stays-isomorphic",
      severity: "error",
      comment:
        "The mobile app must not pull server-only code. This is why @sr/envelope exposes " +
        "a /core entry point: node built-ins and pg belong on the server side of the line.",
      from: { path: "^apps/mobile/" },
      to: { path: "node_modules/(pg|fastify)" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make the boot order unpredictable.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$", "\\.config\\.(js|cjs|ts)$"] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist|coverage)" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mts", ".mjs"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
