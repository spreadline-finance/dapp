import {
  http,
  HttpRequestError,
  ResponseBodyTooLargeError,
  type HttpTransportConfig,
  type Transport,
} from "viem";

const MAX_RESPONSE_BYTES = 2_000_000;
const READ_METHODS = new Set([
  "eth_call",
  "eth_chainId",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
]);

function isRateLimit(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const cause = current as { status?: number; code?: number; cause?: unknown };
    if (cause.status === 429 || cause.code === 429 || cause.code === -32005) return true;
    current = cause.cause;
  }
  return false;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyTooLargeError({ maxSize: MAX_RESPONSE_BYTES, size: contentLength });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError({ maxSize: MAX_RESPONSE_BYTES, size });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function requestTransport(
  url: string,
  fetchFn?: HttpTransportConfig["fetchFn"],
): Transport {
  return (options) => {
    // Both the signal and failure state belong to this request's client. Viem
    // batches by URL + signal and deduplicates by transport UID, never across
    // Worker execution contexts. Completed reads are not cached here.
    const signal = AbortSignal.timeout(18000);
    let rateLimited: HttpRequestError | undefined;
    const providerError = (response: Response, status = response.status) => {
      console.error(JSON.stringify({
        event: "rpc_http_failure",
        status,
        retryAfter: response.headers.get("retry-after"),
        contentType: response.headers.get("content-type"),
        mitigated: response.headers.get("cf-mitigated"),
      }));
      return new HttpRequestError({
        url,
        status,
        headers: response.headers,
        details: status === 429 ? "RPC provider rate limited the request." : "RPC provider unavailable.",
      });
    };
    const transport = http(url, {
      timeout: 12000,
      retryCount: 0,
      maxResponseBodySize: MAX_RESPONSE_BYTES,
      batch: { batchSize: 50, wait: 10 },
      async fetchFn(input, init) {
        if (rateLimited) throw rateLimited;
        const response = await (fetchFn ?? fetch)(input, init);
        // Preserve HTTP status before a singleton error can be mistaken for a
        // successful batch response by Viem's array decoder.
        if (!response.ok) {
          const error = providerError(response);
          if (response.status === 429) rateLimited = error;
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        if (!response.body) return response;
        const body = await readBoundedBody(response);
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
          // Leave malformed success bodies to the transport's normal decoder.
        }
        const members = Array.isArray(payload) ? payload : [payload];
        if (members.some((member) => member && typeof member === "object" && isRateLimit(member.error))) {
          rateLimited = providerError(response, 429);
          if (!Array.isArray(payload)) throw rateLimited;
        }
        // The bytes have already been decoded by fetch; representation headers
        // must not ask the runtime to decode or size that body a second time.
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      },
    })(options);
    return {
      ...transport,
      async request(args, requestOptions) {
        if (rateLimited) throw rateLimited;
        try {
          return await transport.request(args, {
            ...requestOptions,
            signal,
            dedupe: READ_METHODS.has(args.method) && (requestOptions?.dedupe ?? true),
          });
        } catch (error) {
          // A mixed batch still delivers its successful members. Preserve the
          // provider's Retry-After only for members that were rate limited.
          if (rateLimited && isRateLimit(error)) throw rateLimited;
          throw error;
        }
      },
    };
  };
}
