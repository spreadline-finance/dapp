import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir(".wrangler/rewards", { recursive: true });
await build({ entryPoints: ["scripts/rewards-launch.ts"], outfile: ".wrangler/rewards/launch.mjs", bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
const result = spawnSync(process.execPath, [".wrangler/rewards/launch.mjs", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exitCode = result.status ?? 1;
