import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
if (process.env.VERCEL === "1") {
  console.log("Vercel frontend built; API requests are proxied to the configured Worker.");
  process.exit(0);
}
await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await cp("out", "dist/client", { recursive: true });
await build({
  entryPoints: ["server/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("Next.js frontend and live-data Worker packaged.");
