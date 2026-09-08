export class DataError extends Error {
  constructor(message: string, public status: number, public retryAt = 0) { super(message); }
}
const cooldowns = new Map<string, DataError>();
const pausedSnapshots = new Map<string, { value: unknown; retryAt: number }>();
export function retryDeadline(header: string | null, now = Date.now()) {
  if (!header) return now + 60000;
  const seconds = Number(header);
  const deadline = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(header);
  return Number.isFinite(deadline) ? Math.max(now + 1000, deadline) : now + 60000;
}
export function pollingInterval(base: number, error: Error | null, failures = 0, retryAt?: string) {
  const deadline = error instanceof DataError ? error.retryAt : retryAt ? Date.parse(retryAt) : 0;
  return Math.max(base * (error ? Math.min(8, 2 ** Math.max(1, failures)) : 1), (deadline || 0) - Date.now() + 1000);
}
export async function getData<T>(path: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const snapshot = pausedSnapshots.get(path);
  if (snapshot && snapshot.retryAt > Date.now()) return snapshot.value as T;
  pausedSnapshots.delete(path);
  const waiting = cooldowns.get(path);
  if (waiting && waiting.retryAt > Date.now()) throw waiting;
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = new DataError("The data service is reconnecting. Your last observations stay on screen.", 503, Date.now() + 60000);
    cooldowns.set(path, failure);
    throw failure;
  }
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    body = { error: response.status === 404
      ? "The market data service is unavailable on this deployment. Please try again later."
      : "The data service returned an invalid response. Please try again later." };
  }
  if (!response.ok || !body || typeof body !== "object" || "error" in body) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Unable to load live data.";
    const status = response.ok ? 503 : response.status;
    const failure = new DataError(message, status, status === 429 || status >= 500 ? retryDeadline(response.headers.get("retry-after")) : 0);
    if (failure.retryAt) cooldowns.set(path, failure);
    throw failure;
  }
  cooldowns.delete(path);
  if ("dataStatus" in body && body.dataStatus && typeof body.dataStatus === "object" && "retryAt" in body.dataStatus && typeof body.dataStatus.retryAt === "string") {
    pausedSnapshots.set(path, { value: body, retryAt: Date.parse(body.dataStatus.retryAt) });
  }
  while (cooldowns.size > 200) cooldowns.delete(cooldowns.keys().next().value!);
  while (pausedSnapshots.size > 200) pausedSnapshots.delete(pausedSnapshots.keys().next().value!);
  return body as T;
}
export function displayNumber(value: number | string | null | undefined, decimals = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(Number(value));
}
export function shortAddress(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
export function ageLabel(time: string | undefined, now: number) {
  if (!time) return "Awaiting source";
  const age = Math.max(0, Math.floor((now - Date.parse(time)) / 1000));
  if (!Number.isFinite(age)) return "Awaiting source";
  return age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
}
