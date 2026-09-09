"use client";
import { useEffect, useRef, useState } from "react";
import { isAddress, type Address } from "viem";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeftRight, ArrowUpRight, Check, LogOut, Wallet, X } from "lucide-react";
import { CHAIN_ID, EXPLORER, PUBLIC_RPC } from "@/lib/market-types";
import { shortAddress } from "@/lib/live-api";
import { canActivateDemo, isLocalDemoHost, type DemoWallet } from "@/lib/demo-wallet";
import "./demo-wallet.css";
type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (value: unknown) => void) => void;
  removeListener?: (event: string, handler: (value: unknown) => void) => void;
};
type WalletOption = {
  info: { uuid: string; name: string };
  provider: Provider;
};
function readAccount(value: unknown): Address | null {
  return Array.isArray(value) &&
    typeof value[0] === "string" &&
    isAddress(value[0], { strict: false })
    ? value[0]
    : null;
}
function readChain(value: unknown): number | null {
  return typeof value === "string" &&
    /^0x[0-9a-f]+$/i.test(value) &&
    Number.isSafeInteger(Number.parseInt(value, 16))
    ? Number.parseInt(value, 16)
    : null;
}
export function useWallet() {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [demoWallets, setDemoWallets] = useState<readonly DemoWallet[]>([]);
  const [demoWallet, setDemoWallet] = useState<DemoWallet | null>(null);
  const generation = useRef(0);
  const session = useRef(0);
  const accountRevision = useRef(0);
  const unsubscribe = useRef<(() => void) | null>(null);
  useEffect(() => {
    // This literal build guard removes the fixture import from production.
    if (process.env.NODE_ENV === "development") {
      if (!isLocalDemoHost(window.location.hostname)) return;
      let active = true;
      void import("@/lib/demo-wallet-presets").then(({ DEMO_WALLETS }) => {
        if (active) setDemoWallets(DEMO_WALLETS);
      }).catch(() => { /* Real wallet access remains available if a dev chunk fails. */ });
      return () => { active = false; };
    }
  }, []);
  useEffect(() => {
    const operationCounter = generation;
    const sessionCounter = session;
    const announce = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const item = event.detail;
      if (
        !item?.provider ||
        typeof item.provider.request !== "function" ||
        typeof item.info?.uuid !== "string" ||
        typeof item.info?.name !== "string"
      )
        return;
      setWallets((current) =>
        current.some((v) => v.info.uuid === item.info.uuid)
          ? current
          : [
              ...current
                .filter((v) => v.provider !== item.provider)
                .slice(0, 19),
              {
                info: {
                  uuid: item.info.uuid,
                  name: item.info.name.slice(0, 80),
                },
                provider: item.provider,
              },
            ],
      );
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const timer = window.setTimeout(() => {
      const fallback = (window as Window & { ethereum?: Provider }).ethereum;
      if (fallback?.request)
        setWallets((current) =>
          current.length
            ? current
            : [
                {
                  info: { uuid: "injected", name: "Browser wallet" },
                  provider: fallback,
                },
              ],
        );
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("eip6963:announceProvider", announce);
      operationCounter.current++;
      sessionCounter.current++;
      unsubscribe.current?.();
    };
  }, []);
  function disconnect() {
    generation.current++;
    session.current++;
    unsubscribe.current?.();
    unsubscribe.current = null;
    setSelected(null);
    setAccount(null);
    setChainId(null);
    setError("");
    setPending(false);
    setDemoWallet(null);
  }
  function selectDemoWallet(id: string) {
    if (!canActivateDemo(process.env.NODE_ENV, window.location.hostname, pending)) {
      if (process.env.NODE_ENV === "development" && isLocalDemoHost(window.location.hostname))
        setError("Finish or dismiss the current wallet request before switching to a demo wallet.");
      return false;
    }
    const preset = demoWallets.find((item) => item.id === id);
    if (!preset) return false;
    disconnect();
    setDemoWallet(preset);
    return true;
  }
  async function connect(wallet: WalletOption) {
    setDemoWallet(null);
    const id = ++generation.current;
    const walletSession = ++session.current;
    unsubscribe.current?.();
    setSelected(wallet);
    setAccount(null);
    setChainId(null);
    setPending(true);
    setError("");
    const revision = { accounts: 0, chain: 0 };
    const accountsChanged = (value: unknown) => {
      if (session.current !== walletSession) return;
      revision.accounts++;
      accountRevision.current++;
      setAccount(readAccount(value));
    };
    const chainChanged = (value: unknown) => {
      if (session.current !== walletSession) return;
      revision.chain++;
      setChainId(readChain(value));
    };
    const disconnected = () => {
      if (session.current === walletSession) disconnect();
    };
    wallet.provider.on?.("accountsChanged", accountsChanged);
    wallet.provider.on?.("chainChanged", chainChanged);
    wallet.provider.on?.("disconnect", disconnected);
    unsubscribe.current = () => {
      wallet.provider.removeListener?.("accountsChanged", accountsChanged);
      wallet.provider.removeListener?.("chainChanged", chainChanged);
      wallet.provider.removeListener?.("disconnect", disconnected);
    };
    try {
      await wallet.provider.request({ method: "eth_requestAccounts" });
      if (id !== generation.current) return;
      const before = { ...revision };
      const [accounts, chain] = await Promise.all([
        wallet.provider.request({ method: "eth_accounts" }),
        wallet.provider.request({ method: "eth_chainId" }),
      ]);
      if (id !== generation.current) return;
      if (before.accounts === revision.accounts) {
        const next = readAccount(accounts);
        if (!next) throw new Error("No account was returned.");
        setAccount(next);
      }
      if (before.chain === revision.chain) setChainId(readChain(chain));
    } catch {
      if (id === generation.current) {
        session.current++;
        unsubscribe.current?.();
        unsubscribe.current = null;
        setSelected(null);
        setAccount(null);
        setChainId(null);
        setError(
          "Wallet connection was declined or could not be completed. You can retry.",
        );
      }
    } finally {
      if (id === generation.current) setPending(false);
    }
  }
  async function switchAccount() {
    if (demoWallet || !selected || pending) return;
    const id = ++generation.current;
    const wallet = selected;
    setError("");
    setPending(true);
    try {
      await wallet.provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
      if (id !== generation.current) return;
      const revision = accountRevision.current;
      const accounts = await wallet.provider.request({ method: "eth_accounts" });
      if (id !== generation.current || revision !== accountRevision.current) return;
      setAccount(readAccount(accounts));
    } catch (cause) {
      if (id !== generation.current) return;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      setError(code === 4001
        ? "Account change cancelled. Your current account is still connected."
        : code === -32601 || code === 4200
          ? "Choose another account in your wallet extension. Spreadline updates when your wallet changes accounts."
          : "Account change could not be completed. Try again or choose another account in your wallet extension.");
    } finally {
      if (id === generation.current) setPending(false);
    }
  }
  async function switchNetwork() {
    if (demoWallet || !selected) return;
    const id = ++generation.current;
    const wallet = selected;
    setError("");
    setPending(true);
    try {
      try {
        await wallet.provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x1237" }],
        });
      } catch (error) {
        if (id !== generation.current) return;
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 4902
        ))
          throw error;
        await wallet.provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x1237",
              chainName: "Robinhood Chain",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [PUBLIC_RPC],
              blockExplorerUrls: [EXPLORER],
            },
          ],
        });
      }
      if (id !== generation.current) return;
      const chain = await wallet.provider.request({ method: "eth_chainId" });
      if (id === generation.current) setChainId(readChain(chain));
    } catch {
      if (id === generation.current)
        setError(
          "Network change was not completed. Select Robinhood Chain in your wallet.",
        );
    } finally {
      if (id === generation.current) setPending(false);
    }
  }
  return {
    wallets,
    selected: demoWallet ? null : selected,
    account: demoWallet ? null : account,
    chainId: demoWallet ? null : chainId,
    demoWallets,
    demoWallet,
    selectDemoWallet,
    error,
    pending,
    connect,
    switchNetwork,
    switchAccount,
    disconnect,
  };
}
export type WalletState = ReturnType<typeof useWallet>;
export function WalletButton({ wallet }: { wallet: WalletState }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="button button-primary">
        <Wallet size={15} />
        {wallet.demoWallet ? `Demo · ${wallet.demoWallet.name}` : wallet.account ? shortAddress(wallet.account) : "Connect wallet"}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="wallet-dialog">
          <div className="wallet-dialog-heading">
            <div>
              <span className="eyebrow">YOUR WALLET</span>
              <Dialog.Title className="display">
                {wallet.demoWallet ? "Your local demo wallet." : wallet.account
                  ? "Connected account."
                  : "Connect to Spreadline."}
              </Dialog.Title>
            </div>
            <Dialog.Close
              className="icon-button"
              aria-label="Close wallet dialog"
            >
              <X size={19} />
            </Dialog.Close>
          </div>
          <Dialog.Description>
            {wallet.demoWallet ? "These holdings are simulated. Market quotes remain live. Demo mode cannot sign or submit transactions." : "Read your balances on Robinhood Chain. Connecting does not approve spending or submit a trade."}
          </Dialog.Description>
          {wallet.demoWallet ? <div className="demo-wallet-active"><span><Check size={18}/> {wallet.demoWallet.name} · simulated holdings</span><button className="button button-secondary" onClick={wallet.disconnect}><LogOut size={14}/> Exit demo mode</button></div> : wallet.account ? (
            <>
              <div className="wallet-account">
                <Check size={19} />
                <span>
                  {wallet.selected?.info.name}
                  <strong>{shortAddress(wallet.account)}</strong>
                </span>
                <a
                  href={`${EXPLORER}/address/${wallet.account}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View account on explorer"
                >
                  <ArrowUpRight size={18} />
                </a>
              </div>
              <button
                className="button button-secondary"
                disabled={wallet.pending}
                onClick={() => void wallet.switchAccount()}
              >
                <ArrowLeftRight size={14} />
                {wallet.pending ? "Waiting for wallet…" : "Switch account"}
              </button>
              {wallet.wallets.some((item) => item.provider !== wallet.selected?.provider) && (
                <div className="wallet-list wallet-switch-list" aria-label="Switch wallet">
                  <p>Use another wallet</p>
                  {wallet.wallets.filter((item) => item.provider !== wallet.selected?.provider).map((item) => (
                    <button key={item.info.uuid} disabled={wallet.pending} onClick={() => void wallet.connect(item)}>
                      <span className="wallet-avatar">{item.info.name.slice(0, 1)}</span>
                      {item.info.name}
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
                </div>
              )}
              {wallet.chainId !== CHAIN_ID && (
                <button
                  className="button button-primary"
                  disabled={wallet.pending}
                  onClick={() => void wallet.switchNetwork()}
                >
                  {wallet.pending
                    ? "Waiting for wallet…"
                    : "Switch to Robinhood Chain"}
                </button>
              )}
              <button
                className="button button-secondary"
                onClick={wallet.disconnect}
              >
                <LogOut size={14} />
                Disconnect from this app
              </button>
            </>
          ) : wallet.wallets.length ? (
            <div className="wallet-list">
              {wallet.wallets.map((item) => (
                <button
                  key={item.info.uuid}
                  disabled={wallet.pending}
                  onClick={() => void wallet.connect(item)}
                >
                  <span className="wallet-avatar">
                    {item.info.name.slice(0, 1)}
                  </span>
                  {item.info.name}
                  <ArrowUpRight size={17} />
                </button>
              ))}
              {wallet.pending && (
                <p role="status">Confirm the connection in your wallet.</p>
              )}
            </div>
          ) : (
            <div className="wallet-missing">
              <Wallet size={28} />
              <h3>No browser wallet detected.</h3>
              <p>
                Open this site in a browser with an EVM wallet extension, or use
                a wallet’s in-app browser. You can explore markets without
                connecting.
              </p>
            </div>
          )}
          {wallet.demoWallets.length > 0 && <section className="demo-wallet-picker" aria-label="Local demo wallets">
            <div><span className="eyebrow">LOCAL DEVELOPMENT ONLY</span><h3>Try a demo wallet</h3><p>Pick preset holdings to explore Portfolio and the position planner. No extension needed. Resets on reload.</p></div>
            {wallet.demoWallets.map((preset) => <button key={preset.id} type="button" disabled={wallet.pending} aria-label={`Use ${preset.name} demo wallet`} aria-pressed={wallet.demoWallet?.id === preset.id} onClick={() => { if (wallet.selectDemoWallet(preset.id)) setOpen(false); }}>
              <span><strong>{preset.name}</strong><small>{preset.description}</small><span>{Number(preset.balances.USDG).toLocaleString("en-US")} USDG · {Number(preset.balances.NVDA).toLocaleString("en-US", { maximumFractionDigits: 4 })} NVDA</span></span><span aria-hidden="true">{wallet.demoWallet?.id === preset.id ? <Check size={18}/> : <ArrowUpRight size={18}/>}</span>
            </button>)}
          </section>}
          {wallet.error && (
            <p className="desk-error-inline" role="alert">
              {wallet.error}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DemoWalletNotice({ wallet }: { wallet: WalletState }) {
  if (!wallet.demoWallet) return null;
  return <div className="demo-wallet-notice" role="status"><Wallet size={18}/><div><strong>Local simulation · {wallet.demoWallet.name}</strong><span>Holdings are simulated; quotes are live. Transactions disabled.</span></div><button type="button" onClick={wallet.disconnect}>Exit demo <LogOut size={14}/></button></div>;
}
