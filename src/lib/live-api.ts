export class DataError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function getData<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal,
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DataError(
      "The data service is unavailable. Please retry.",
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Unable to load live data.";
    throw new DataError(message, response.status);
  }
  return body as T;
}
export function displayNumber(
  value: number | string | null | undefined,
  decimals = 2,
) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(Number(value));
}
export function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
export function ageLabel(time: string | undefined, now: number) {
  if (!time) return "Unavailable";
  const age = Math.max(0, Math.floor((now - Date.parse(time)) / 1000));
  if (!Number.isFinite(age)) return "Unavailable";
  return age < 60
    ? `${age}s ago`
    : age < 3600
      ? `${Math.floor(age / 60)}m ago`
      : `${Math.floor(age / 3600)}h ago`;
}
