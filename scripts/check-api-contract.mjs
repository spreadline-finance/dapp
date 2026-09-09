import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import contract from "../config/api-contract.json" with { type: "json" };

const RELEASE_ACTION = "Deploy the current Cloudflare Worker first, verify SPREADLINE_API_ORIGIN in Vercel, then retry the frontend build.";
class ApiContractError extends Error {}

export function validateApiContract(health) {
  if (!health || typeof health !== "object" || health.status !== "ok" || health.chainId !== contract.chainId)
    throw new ApiContractError(`The API health response is not a healthy Robinhood Chain service. ${RELEASE_ACTION}`);
  if (health.apiVersion !== contract.apiVersion)
    throw new ApiContractError(`The deployed Worker does not support API contract v${contract.apiVersion}. ${RELEASE_ACTION}`);
  if (!Array.isArray(health.capabilities) || !contract.capabilities.every((name) => health.capabilities.includes(name)))
    throw new ApiContractError(`The deployed Worker is missing required capabilities: ${contract.capabilities.join(", ")}. ${RELEASE_ACTION}`);
  return true;
}

export function apiContractOrigin(env) {
  if (!env.SPREADLINE_API_ORIGIN)
    throw new ApiContractError(`SPREADLINE_API_ORIGIN is required for a Vercel build. ${RELEASE_ACTION}`);
  let origin, site;
  try {
    origin = new URL(env.SPREADLINE_API_ORIGIN);
    site = new URL(env.NEXT_PUBLIC_SITE_URL || "https://spredline.vercel.app");
  } catch {
    // URL parser errors can include the original string, including credentials.
    throw new ApiContractError("SPREADLINE_API_ORIGIN and NEXT_PUBLIC_SITE_URL must be valid deployment URLs. Do not include credentials in either value.");
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(origin.hostname))
    throw new ApiContractError("SPREADLINE_API_ORIGIN must be a public HTTPS origin without credentials, paths or query parameters.");
  if (origin.origin === site.origin || origin.hostname === env.VERCEL_URL || origin.hostname === env.VERCEL_PROJECT_PRODUCTION_URL)
    throw new ApiContractError("SPREADLINE_API_ORIGIN must point to the Cloudflare Worker, not the frontend. Check the Vercel API origin setting.");
  return origin.origin;
}

async function readHealth(response) {
  const limit = 65536;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ApiContractError(`The API health response is too large. ${RELEASE_ACTION}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiContractError(`The API health response is empty. ${RELEASE_ACTION}`);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiContractError(`The API health response is too large. ${RELEASE_ACTION}`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiContractError(`The API health endpoint did not return valid JSON. ${RELEASE_ACTION}`); }
}

export async function checkApiContract(env = process.env, fetchImpl = fetch) {
  if (env.VERCEL !== "1") return { skipped: true };
  const origin = apiContractOrigin(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(`${origin}/api/health`, {
      method: "GET", headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiContractError(`The API health endpoint returned HTTP ${response.status}. ${RELEASE_ACTION}`);
    }
    validateApiContract(await readHealth(response));
    return { skipped: false, apiVersion: contract.apiVersion };
  } catch (error) {
    if (error instanceof ApiContractError) throw error;
    throw new ApiContractError(`The API health endpoint is unreachable or timed out after 10 seconds. ${RELEASE_ACTION}`);
  } finally { clearTimeout(timeout); }
}

// The basename guard also keeps this CLI entrypoint inert in bundled unit tests.
const filename = fileURLToPath(import.meta.url);
if (basename(filename) === "check-api-contract.mjs" && process.argv[1] && resolve(process.argv[1]) === filename) {
  try {
    const result = await checkApiContract();
    if (!result.skipped) console.log(`API contract v${result.apiVersion} verified; building the Vercel frontend.`);
  } catch (error) {
    console.error(error instanceof ApiContractError ? error.message : `API contract verification failed. ${RELEASE_ACTION}`);
    process.exitCode = 1;
  }
}
