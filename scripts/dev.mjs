import { spawn } from "node:child_process";
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const [cmd, args] of [
  [
    "node_modules/.bin/wrangler",
    ["dev", "--ip", "127.0.0.1", "--port", "8787"],
  ],
  ["node_modules/.bin/next", ["dev", ...process.argv.slice(2)]],
]) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: ".wrangler/logs",
    },
  });
  children.push(child);
  child.on("exit", (code) => stop(code ?? 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
