import { DataError, getData } from "./live-api";
import { ARBITRAGE_INTERVAL, monitorRetryDelay, quoteMatchesSelection } from "./arbitrage-monitor";
import type { QuoteBook } from "./market-types";

// One admission window across live monitoring, batch research and route inspection
// within this app tab. The API also enforces the shared cross-tab/IP budget.
function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
type QuoteClientOptions = {
  read: (symbol: string, amount: string, signal: AbortSignal) => Promise<QuoteBook>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};
export function createResearchQuoteClient({ read, now = Date.now, sleep = wait }: QuoteClientOptions) {
  let nextAt = 0, retryAt = 0, inFlight = false, failures = 0;
  const status = () => ({ nextAt: Math.max(nextAt, retryAt), inFlight, retryAt });
  async function request(symbol: string, amount: string, signal: AbortSignal): Promise<QuoteBook> {
    while (inFlight || now() < Math.max(nextAt, retryAt)) {
      await sleep(Math.max(250, Math.min(ARBITRAGE_INTERVAL, Math.max(nextAt, retryAt) - now())), signal);
    }
    signal.throwIfAborted();
    inFlight = true;
    nextAt = now() + ARBITRAGE_INTERVAL;
    try {
      const quote = await read(symbol, amount, signal);
      signal.throwIfAborted();
      if (!quoteMatchesSelection(quote, symbol, amount)) throw new Error("The returned quote did not match this market and amount.");
      failures = 0; retryAt = 0;
      return quote;
    } catch (error) {
      if (!signal.aborted) {
        failures++;
        retryAt = Math.max(now() + monitorRetryDelay(failures), error instanceof DataError && error.retryAt ? error.retryAt + 1000 : 0);
      }
      throw error;
    } finally { inFlight = false; }
  }
  return { request, status };
}
const client = createResearchQuoteClient({ read: (symbol, amount, signal) => getData<QuoteBook>(`quote?symbol=${encodeURIComponent(symbol)}&amount=${encodeURIComponent(amount)}`, signal) });
export const requestResearchQuote = client.request;
export const researchQuoteStatus = client.status;
