import {
  http,
  HttpRequestError,
  type HttpTransportConfig,
  type Transport,
} from "viem";

export function requestTransport(
  url: string,
  fetchFn?: HttpTransportConfig["fetchFn"],
): Transport {
  // Viem batches by URL + request signal. A unique signal keeps concurrent
  // Worker requests from sharing promises across Cloudflare execution contexts.
  const signal = AbortSignal.timeout(18000);
  const factory = http(url, {
    timeout: 12000,
    retryCount: 1,
    maxResponseBodySize: 2_000_000,
    batch: { batchSize: 50, wait: 10 },
    fetchFn,
    onFetchResponse(response) {
      if (!response.ok) {
        console.error(
          JSON.stringify({
            event: "rpc_http_failure",
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
            contentType: response.headers.get("content-type"),
            mitigated: response.headers.get("cf-mitigated"),
          }),
        );
        // Preserve non-2xx status before a non-array JSON-RPC error can be
        // mistaken for a successful batch response by the transport decoder.
        throw new HttpRequestError({
          url,
          status: response.status,
          headers: response.headers,
          details: "RPC provider unavailable.",
        });
      }
    },
  });
  return (options) => {
    const transport = factory(options);
    return {
      ...transport,
      request: (args, requestOptions) =>
        transport.request(args, { ...requestOptions, signal }),
    };
  };
}
