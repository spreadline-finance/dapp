import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(".wrangler/desk", { recursive: true });
await build({ entryPoints: ["scripts/desk-operator.ts"], outfile: ".wrangler/desk/operator.mjs", bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
const result = spawnSync(process.execPath, [".wrangler/desk/operator.mjs", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exitCode = result.status ?? 1;
