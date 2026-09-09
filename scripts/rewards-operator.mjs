import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
await mkdir(".wrangler/rewards", { recursive: true });
await build({ entryPoints: ["scripts/rewards-operator.ts"], outfile: ".wrangler/rewards/operator.mjs", bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
const child = spawn(process.execPath, [".wrangler/rewards/operator.mjs", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
