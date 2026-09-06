import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(".wrangler/tests", { recursive: true });
await build({
  entryPoints: ["tests/data.test.ts"],
  outfile: ".wrangler/tests/data.test.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
});
const result = spawnSync(
  process.execPath,
  ["--test", ".wrangler/tests/data.test.mjs"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
