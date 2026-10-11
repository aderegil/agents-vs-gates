/**
 * Architecture rules for orders-service. Each rule name starts with its ID from
 * ARCHITECTURE-RULES.md. Known (frozen) violations live in
 * .dependency-cruiser-known-violations.json and are ignored with --ignore-known.
 */
module.exports = {
  forbidden: [
    {
      name: "ARCH-1-core-no-api-or-adapters",
      comment: "ARCH-1: core/ never imports api/ or adapters/. Core declares ports; adapters implement them.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/(api|adapters)/" },
    },
    {
      name: "ARCH-2-api-no-adapters",
      comment: "ARCH-2: api/ goes through core/; it never imports adapters/.",
      severity: "error",
      from: { path: "^src/api/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "ARCH-3-only-adapters-do-io",
      comment: "ARCH-3: only adapters/ do I/O. core/ and api/ must not import network or process modules.",
      severity: "error",
      from: { path: "^src/(core|api)/" },
      to: {
        dependencyTypes: ["core"],
        path: "^(node:)?(http|https|http2|net|tls|dgram|dns|child_process)$",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js"],
    },
  },
};
