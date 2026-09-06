export type WalletProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
// Shared by lending and swaps, including tickets that unmount while the wallet is open.
// Strong references last only until each submission's finally block. A Set also
// lets local demo mode check every active request across component remounts.
export const walletSubmissions = new Set<WalletProvider>();
