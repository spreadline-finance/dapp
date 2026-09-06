"use client";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { Check, Download, Share2, WifiOff } from "lucide-react";
import "./pwa.css";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type PwaState = { installed: boolean; offline: boolean; canPrompt: boolean; isApple: boolean; secure: boolean; install: () => Promise<boolean> };
const PwaContext = createContext<PwaState | null>(null);

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const prompt = useRef<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [offline, setOffline] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [isApple, setApple] = useState(false);
  const [secure, setSecure] = useState(true);
  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const sync = () => {
      setInstalled(standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
      setOffline(!navigator.onLine);
      setApple(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
      setSecure(window.isSecureContext);
    };
    const capture = (event: Event) => { event.preventDefault(); prompt.current = event as InstallEvent; setCanPrompt(true); };
    const complete = () => { prompt.current = null; setCanPrompt(false); setInstalled(true); };
    sync();
    standalone.addEventListener("change", sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", complete);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      // Offline fallback only. Never force an update or reload during a wallet flow.
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => { /* Installation can still be offered without offline support. */ });
    }
    return () => {
      standalone.removeEventListener("change", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const syncViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Let browser zoom behave normally; do not resize UI to defeat magnification.
        if (viewport.scale !== 1) return;
        root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
        root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
        root.dataset.keyboardOpen = String(window.innerHeight - viewport.height > 140);
      });
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
      delete root.dataset.keyboardOpen;
    };
  }, []);
  async function install() {
    const event = prompt.current;
    if (!event) return false;
    prompt.current = null; setCanPrompt(false);
    try { await event.prompt(); await event.userChoice; return true; }
    catch { return false; }
  }
  return <PwaContext.Provider value={{ installed, offline, canPrompt, isApple, secure, install }}>{children}</PwaContext.Provider>;
}

export function PwaInstallButton() {
  const state = useContext(PwaContext);
  const [help, setHelp] = useState(false), [busy, setBusy] = useState(false);
  const id = useId();
  if (!state) return null;
  if (state.installed) return <span className="pwa-installed"><Check size={16}/>App installed</span>;
  return <div className="pwa-install">
    <button className="pwa-install-button" disabled={busy} aria-expanded={help} aria-controls={id} onClick={async () => {
      if (!state.canPrompt) { setHelp(!help); return; }
      setBusy(true);
      if (!await state.install()) setHelp(true);
      setBusy(false);
    }}><Download size={17}/><span>{busy ? "Opening install…" : "Install Spreadline"}</span></button>
    {help && <div className="pwa-install-help" id={id} role="status">{!state.secure ? <p>Installation needs a secure address. On this computer, open localhost. On your phone, use a trusted HTTPS development address.</p> : state.isApple ? <><Share2 size={18}/><p>Open your browser’s Share menu, choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>. If available, keep Open as Web App enabled.</p></> : <p>Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>. If it isn’t offered, try Chrome, Edge, or Safari.</p>}</div>}
  </div>;
}
export function ConnectionNotice() {
  const state = useContext(PwaContext);
  return state?.offline ? <div className="pwa-offline-notice" role="status"><WifiOff size={18}/><p>You’re offline. Displayed values may be old. Reconnect and refresh before preparing a transaction.</p></div> : null;
}
