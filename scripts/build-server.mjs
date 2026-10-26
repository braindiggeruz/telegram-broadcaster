import { build } from "esbuild";
await build({
  entryPoints: { index: "server/_core/index.ts", worker: "server/worker.ts" },
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  treeShaking: true,
});
