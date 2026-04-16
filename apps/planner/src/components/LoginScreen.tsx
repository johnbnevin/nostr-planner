import { useState, useEffect, useRef, useCallback } from "react";
import {
  Calendar,
  Eye,
  EyeOff,
  Copy,
  Check,
  ChevronLeft,
  Link2,
  ShieldCheck,
  KeyRound,
  QrCode,
  BookKey,
  Loader,
  Lock,
  HelpCircle,
  Smartphone,
} from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { LocalSigner } from "../lib/localSigner";
import { connectNostrSigner, connectBunkerUri } from "../lib/nip46Signer";
import { DEFAULT_RELAYS } from "../lib/nostr";
import { isTauri } from "../lib/platform";
import { queryEvents } from "../lib/relay";
import { lsSet } from "../lib/storage";
import { nip19 } from "nostr-tools";
import {
  generateSeedWords,
  privateKeyFromSeedWords,
  validateWords,
} from "nostr-tools/nip06";
import QRCode from "qrcode";

/* ── Platform detection for signer recommendations ──────────────── */

interface SignerRec {
  name: string;
  note: string;
  url?: string;
}

const MOBILE_SIGNERS: Record<string, SignerRec[]> = {
  iPhone: [
    { name: "Alby Go", note: "Nostr signer and Lightning wallet", url: "https://apps.apple.com/us/app/alby-go/id6471335774" },
    { name: "Nostur", note: "Full Nostr client with built-in key management", url: "https://apps.apple.com/us/app/nostur-nostr-client/id1672780508" },
  ],
  Android: [
    { name: "Amber", note: "Dedicated signer app — keys never leave the device (recommended)", url: "https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner" },
    { name: "Amethyst", note: "Full Nostr client with built-in key management", url: "https://play.google.com/store/apps/details?id=com.vitorpamplona.amethyst" },
  ],
};

const BROWSER_SIGNERS: Record<string, SignerRec[]> = {
  Chrome: [
    { name: "Soapbox Signer", note: "Simple, fast NIP-07 signer", url: "https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo" },
    { name: "nostr-keyx", note: "Uses OS keychain or YubiKey", url: "https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4" },
  ],
  Firefox: [
    { name: "Soapbox Signer", note: "Simple, fast NIP-07 signer", url: "https://addons.mozilla.org/en-US/firefox/addon/soapbox-signer/" },
  ],
  Brave: [
    { name: "Soapbox Signer", note: "Chrome extensions work in Brave", url: "https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo" },
    { name: "nostr-keyx", note: "Uses OS keychain or YubiKey", url: "https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4" },
  ],
  Edge: [
    { name: "nostr-keyx", note: "Uses OS keychain or YubiKey", url: "https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4" },
  ],
  Opera: [
    { name: "nostr-keyx", note: "Uses OS keychain or YubiKey", url: "https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4" },
  ],
  Safari: [
    { name: "Alby Go", note: "Nostr signer and Lightning wallet", url: "https://apps.apple.com/us/app/alby-go/id6471335774" },
  ],
};

function detectPlatform(): { isMobile: boolean; platform: string } {
  if (isTauri()) return { isMobile: false, platform: "Tauri" };
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return { isMobile: true, platform: "iPhone" };
  if (/Android/.test(ua)) return { isMobile: true, platform: "Android" };
  if (/Firefox/.test(ua)) return { isMobile: false, platform: "Firefox" };
  if (/Edg\//.test(ua)) return { isMobile: false, platform: "Edge" };
  if (/OPR\//.test(ua)) return { isMobile: false, platform: "Opera" };
  if (/Brave/.test(ua)) return { isMobile: false, platform: "Brave" };
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return { isMobile: false, platform: "Safari" };
  if (/Chrome/.test(ua)) return { isMobile: false, platform: "Chrome" };
  return { isMobile: false, platform: "Chrome" };
}

function getSignerRecommendation(): string {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers) return `No Nostr signer found. On ${platform}, try ${signers.map((s) => s.name).join(" or ")}.`;
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers) return `No Nostr extension found. For ${platform}, install ${signers.map((s) => s.name).join(" or ")}.`;
  return "No Nostr extension found. Install a NIP-07 browser extension like Soapbox Signer.";
}

function getTopSignerForPlatform(): { name: string; url?: string; isMobile: boolean; platform: string } {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers?.[0]) return { ...signers[0], isMobile, platform };
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers?.[0]) return { ...signers[0], isMobile, platform };
  return { name: "Soapbox Signer", url: "https://chromewebstore.google.com/detail/soapbox-signer/bcoopbammbdnfkbalnfaljhdhhmajnoo", isMobile, platform };
}

/* ── SignerRecommendations component ───────────────────────────── */

function SignerSection({ title, items, highlight }: { title: string; items: Record<string, SignerRec[]>; highlight?: string }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-gray-900 text-xs">{title}</p>
      <div className="space-y-0.5">
        {Object.entries(items).map(([plat, signers]) => (
          <div key={plat} className={plat === highlight ? "font-medium" : "text-gray-500"}>
            <span className="text-xs">
              {plat === highlight && "\u2192 "}<strong>{plat}:</strong>{" "}
              {signers.map((s, i) => (
                <span key={s.name}>
                  {i > 0 && ", "}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">{s.name}</a>
                  ) : s.name}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignerRecommendations() {
  const { isMobile, platform } = detectPlatform();

  return (
    <div className="space-y-2 text-xs">
      <SignerSection title="Mobile" items={MOBILE_SIGNERS} highlight={isMobile ? platform : undefined} />
      <SignerSection title="Desktop browsers" items={BROWSER_SIGNERS} highlight={!isMobile ? platform : undefined} />
    </div>
  );
}

/* ── Tips ──────────────────────────────────────────────────────── */

const LOGIN_TIPS = [
  "Tip: Your calendar events are encrypted by default. Only you can read them.",
  "Tip: You can use your same login credentials across many Nostr apps. See a list at nostrapps.com",
  "Tip: Nostr is very versatile, and so are your login credentials. Find out more at nostr.how",
  "Tip: You own your identity on Nostr. No company can ban you or take your account away.",
  "Tip: Your nsec key is like a master password — never share it with anyone or paste it into untrusted sites.",
  "Tip: Browser extensions like Soapbox Signer or nostr-keyx can manage your keys more securely than pasting an nsec.",
  "Tip: Every event on Nostr is cryptographically signed — nobody can forge data in your name without your nsec.",
  "Tip: Planner backs up to Blossom servers — log in anywhere and restore your calendar.",
  "Tip: Shared calendars use NIP-44 encryption. Only invited participants can see events.",
  "Tip: Public calendars use NIP-52 — other Nostr clients can see them too.",
];

/* ── Types ──────────────────────────────────────────────────────── */

type Step = "main" | "key-backup" | "done";
type LoginView = "main" | "nsec" | "mnemonic" | "signer" | "unlock";

/* ── Component ──────────────────────────────────────────────────── */

export function LoginScreen() {
  const { loginWithExtension, loginWithSigner, signEvent, publishEvent } = useNostr();
  const inTauri = isTauri();

  // Signup flow state
  const [step, setStep] = useState<Step>("main");
  const [name, setName] = useState("");
  const [nsec, setNsec] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);
  const [showSignerInfo, setShowSignerInfo] = useState(false);
  const [showWhyLong, setShowWhyLong] = useState(false);

  // Login view state
  const [loginView, setLoginView] = useState<LoginView>("main");

  // Extension login
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionError, setExtensionError] = useState<string | null>(null);

  // Direct nsec login
  const [loginNsec, setLoginNsec] = useState("");
  const [nsecLoginLoading, setNsecLoginLoading] = useState(false);
  const [nsecLoginError, setNsecLoginError] = useState<string | null>(null);

  // Mnemonic login (NIP-06)
  const [seedPhrase, setSeedPhrase] = useState("");
  const [seedPassphrase, setSeedPassphrase] = useState("");
  const [showSeedPassphrase, setShowSeedPassphrase] = useState(false);
  const [seedLoginLoading, setSeedLoginLoading] = useState(false);
  const [seedLoginError, setSeedLoginError] = useState<string | null>(null);

  // NIP-46 QR / bunker login
  const [connectUri, setConnectUri] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [connectWaiting, setConnectWaiting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [bunkerLoading, setBunkerLoading] = useState(false);
  const [bunkerError, setBunkerError] = useState<string | null>(null);
  const connectAbortRef = useRef<AbortController | null>(null);

  // Tauri stored key unlock
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // Tauri: save key on signup/nsec login
  const [tauriPassword, setTauriPassword] = useState("");
  const [saveKeyToStore, setSaveKeyToStore] = useState(true);

  // Hidden form ref for browser password manager
  const passwordFormRef = useRef<HTMLFormElement>(null);
  const loginFormRef = useRef<HTMLFormElement>(null);

  // Tips rotation
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * LOGIN_TIPS.length));

  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex(prev => (prev + 1) % LOGIN_TIPS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Clear sensitive state when navigating between login views to minimize
  // key material exposure in memory (e.g. user types nsec, then switches to QR login).
  const switchLoginView = useCallback((view: LoginView) => {
    if (view !== "nsec") { setLoginNsec(""); setNsecLoginError(null); }
    if (view !== "mnemonic") { setSeedPhrase(""); setSeedPassphrase(""); setSeedLoginError(null); }
    if (view !== "signer") { connectAbortRef.current?.abort(); setConnectWaiting(false); setQrDataUrl(""); setConnectUri(""); setConnectError(null); }
    if (view !== "unlock") { setUnlockPassword(""); setUnlockError(""); }
    setBunkerUrl(""); setBunkerError(null);
    setLoginView(view);
  }, []);

  // On mount, check for stored Tauri key
  useEffect(() => {
    if (inTauri) {
      LocalSigner.hasStoredKey().then((has) => {
        if (has) setLoginView("unlock");
      }).catch(() => {});
    }
  }, [inTauri]);

  // Cleanup on unmount: abort NIP-46 and clear sensitive state from memory
  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort();
      // Best-effort: clear sensitive key material from React state on unmount.
      // React may retain the state object briefly, but this minimizes the window.
      setNsec("");
      setMnemonic("");
      setLoginNsec("");
      setSeedPhrase("");
      setSeedPassphrase("");
      setTauriPassword("");
      setUnlockPassword("");
    };
  }, []);

  const topSigner = getTopSignerForPlatform();

  /* ── Signup: generate key from NIP-06 seed phrase ─────────────── */

  const handleStart = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const words = generateSeedWords();
    const sk = privateKeyFromSeedWords(words);
    setMnemonic(words);
    setNsec(nip19.nsecEncode(sk));
    setStep("key-backup");
  };

  const copyNsec = async () => {
    try {
      await navigator.clipboard.writeText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Clear clipboard after 30s to limit nsec exposure window
      setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); }, 30000);
    } catch { /* clipboard denied */ }
  };

  const copyMnemonicWords = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setMnemonicCopied(true);
      setTimeout(() => setMnemonicCopied(false), 2000);
      // Clear clipboard after 30s to limit mnemonic exposure (matches nsec behavior)
      setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); }, 30000);
    } catch { /* clipboard denied */ }
  };

  /** Complete signup: login with generated key + publish kind:0 profile. */
  const handleSaved = async () => {
    setIsCreating(true);
    try {
      // Trigger browser password manager save (best-effort)
      try {
        if ("PasswordCredential" in window) {
          const cred = new (window as Window & { PasswordCredential: new (opts: { id: string; password: string; name: string }) => Credential }).PasswordCredential({
            id: name.trim() || "nostr-user",
            password: nsec,
            name: name.trim() || "nostr-user",
          });
          await navigator.credentials.store(cred);
        } else {
          passwordFormRef.current?.requestSubmit();
        }
      } catch { /* best-effort */ }

      const signer = LocalSigner.fromKey(nsec);

      // On Tauri, save encrypted key if password provided
      if (inTauri && saveKeyToStore && tauriPassword) {
        await signer.saveToStore(tauriPassword);
      }

      await loginWithSigner(signer);

      // Publish kind:0 profile metadata (best-effort, read-then-merge to
      // preserve existing fields like picture, about, nip05, lud16, etc.)
      try {
        if (name.trim()) {
          let existing: Record<string, unknown> = {};
          try {
            const pk = await signer.getPublicKey();
            const events = await queryEvents(DEFAULT_RELAYS, {
              kinds: [0],
              authors: [pk],
              limit: 1,
            });
            if (events.length > 0) {
              existing = JSON.parse(events[0].content);
            }
          } catch { /* if fetch fails, publish name-only */ }
          const event = await signEvent({
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify({ ...existing, name: name.trim() }),
          });
          await publishEvent(event);
        }
      } catch { /* profile publish is best-effort */ }

      setNsec("");
      setMnemonic("");
      setStep("done");
    } finally {
      setIsCreating(false);
    }
  };

  /* ── NIP-07 extension login ────────────────────────────────────── */

  const handleExtensionLogin = async () => {
    setExtensionLoading(true);
    setExtensionError(null);
    try {
      if (!("nostr" in window)) throw new Error(getSignerRecommendation());
      if (!inTauri) lsSet("nostr-planner-login-type", "extension");
      await loginWithExtension();
    } catch (e: unknown) {
      setExtensionError((e as Error).message || "Extension login failed");
    } finally {
      setExtensionLoading(false);
    }
  };

  /* ── Direct nsec login ─────────────────────────────────────────── */

  const handleNsecDirectLogin = async () => {
    const trimmed = loginNsec.trim();
    if (!trimmed) { setNsecLoginError("Please enter your nsec key"); return; }
    if (!trimmed.startsWith("nsec1")) { setNsecLoginError("Invalid key — must start with nsec1"); return; }
    setNsecLoginLoading(true);
    setNsecLoginError(null);
    try {
      const signer = LocalSigner.fromKey(trimmed);
      if (inTauri && saveKeyToStore && tauriPassword) {
        await signer.saveToStore(tauriPassword);
      }
      setLoginNsec("");
      await loginWithSigner(signer);
    } catch (e: unknown) {
      setNsecLoginError((e as Error).message || "Login failed");
    } finally {
      setNsecLoginLoading(false);
    }
  };

  /* ── NIP-06 mnemonic login ─────────────────────────────────────── */

  const handleSeedLogin = async () => {
    const words = seedPhrase.trim().toLowerCase().replace(/\s+/g, " ");
    if (!words) { setSeedLoginError("Please enter your seed phrase"); return; }
    if (!validateWords(words)) { setSeedLoginError("Invalid seed phrase — check the words and try again"); return; }
    setSeedLoginLoading(true);
    setSeedLoginError(null);
    try {
      const sk = privateKeyFromSeedWords(words, seedPassphrase || undefined);
      const nsecKey = nip19.nsecEncode(sk);
      const signer = LocalSigner.fromKey(nsecKey);
      if (inTauri && saveKeyToStore && tauriPassword) {
        await signer.saveToStore(tauriPassword);
      }
      setSeedPhrase("");
      setSeedPassphrase("");
      await loginWithSigner(signer);
    } catch (e: unknown) {
      setSeedLoginError((e as Error).message || "Failed to derive key from seed phrase");
    } finally {
      setSeedLoginLoading(false);
    }
  };

  /* ── NIP-46 QR code login ──────────────────────────────────────── */

  const generateConnectQR = useCallback(async () => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;
    setConnectError(null);
    setConnectWaiting(true);
    setConnectUri("");
    setQrDataUrl("");
    try {
      const { signer } = await connectNostrSigner(controller.signal, async (uri) => {
        setConnectUri(uri);
        try {
          const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
          if (!controller.signal.aborted) setQrDataUrl(dataUrl);
        } catch { /* QR generation failed */ }
      });
      if (!inTauri) lsSet("nostr-planner-login-type", "bunker");
      connectAbortRef.current = null;
      await loginWithSigner(signer);
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const msg = (e as Error).message || "Connection failed";
      if (!msg.includes("abort")) setConnectError(msg);
    } finally {
      if (!controller.signal.aborted) setConnectWaiting(false);
    }
  }, [loginWithSigner, inTauri]);

  /* ── Bunker URI login ──────────────────────────────────────────── */

  const handleBunkerLogin = async () => {
    const trimmed = bunkerUrl.trim();
    if (!trimmed) { setBunkerError("Please enter a bunker or nostrconnect URL"); return; }
    if (!trimmed.startsWith("bunker://") && !trimmed.startsWith("nostrconnect://")) {
      setBunkerError("Invalid URL — must start with bunker:// or nostrconnect://");
      return;
    }
    setBunkerLoading(true);
    setBunkerError(null);
    try {
      const { signer } = await connectBunkerUri(trimmed, 120_000);
      if (!inTauri) lsSet("nostr-planner-login-type", "bunker");
      await loginWithSigner(signer);
    } catch (e: unknown) {
      const errMsg = (e as Error).message || "Bunker login failed";
      if (errMsg.toLowerCase().includes("already connected")) {
        setBunkerError("Already connected. Try clearing browser data/site settings and re-paste your bunker URL.");
      } else if (errMsg.toLowerCase().includes("invalid secret") || errMsg.toLowerCase().includes("invalid token")) {
        setBunkerError("This login link has expired. Please get a fresh bunker URL from your signer and try again.");
      } else if (errMsg.toLowerCase().includes("timeout") || errMsg.toLowerCase().includes("timed out")) {
        setBunkerError("Connection timed out. Check your internet and try again.");
      } else {
        setBunkerError(errMsg);
      }
    } finally {
      setBunkerLoading(false);
    }
  };

  /* ── Tauri stored key unlock ───────────────────────────────────── */

  const handleUnlockStoredKey = async () => {
    setUnlockError("");
    if (!unlockPassword) { setUnlockError("Please enter your password."); return; }
    setUnlocking(true);
    try {
      const signer = await LocalSigner.loadFromStore(unlockPassword);
      if (!signer) { setUnlockError("Wrong password or corrupted key store."); return; }
      setUnlockPassword("");
      await loginWithSigner(signer);
    } catch {
      setUnlockError("Wrong password or corrupted key store.");
    } finally {
      setUnlocking(false);
    }
  };

  /* ── Tauri: optional key encryption section ────────────────────── */

  const tauriSaveKeySection = inTauri && (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={saveKeyToStore}
          onChange={(e) => setSaveKeyToStore(e.target.checked)}
          className="rounded"
        />
        Save key encrypted (recommended)
      </label>
      {saveKeyToStore && (
        <input
          type="password"
          value={tauriPassword}
          onChange={(e) => setTauriPassword(e.target.value)}
          placeholder="Encryption password"
          className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          autoComplete="new-password"
        />
      )}
      {saveKeyToStore && (
        <p className="text-xs text-gray-400">
          Encrypted with NIP-49 (scrypt + XChaCha20-Poly1305)
        </p>
      )}
    </div>
  );

  /* ── Render: key backup screen ─────────────────────────────────── */

  if (step === "key-backup") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full space-y-5">
          {/* Hidden form to trigger browser password save */}
          <iframe name="pw-sink" style={{ display: "none" }} tabIndex={-1} aria-hidden="true" />
          <form
            ref={passwordFormRef}
            method="POST"
            action="about:blank"
            target="pw-sink"
            style={{ position: "absolute", left: "-9999px", top: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}
          >
            <input type="text" name="username" value={name || "nostr-user"} autoComplete="username" onChange={() => {}} />
            <input type="password" name="password" value={nsec} autoComplete="new-password" onChange={() => {}} />
            <button type="submit" />
          </form>

          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold text-gray-900">Save your password</h2>
            <p className="text-sm text-gray-500">
              This is your password.{" "}
              <button type="button" onClick={() => setShowWhyLong(true)} className="underline underline-offset-2 font-medium text-gray-900 hover:text-primary-600 inline-flex items-center gap-0.5">
                Why is it so long<HelpCircle className="h-3 w-3 inline" />
              </button>
              {" "}Save it in your{" "}
              <button type="button" onClick={() => setShowSignerInfo(true)} className="underline underline-offset-2 font-medium text-gray-900 hover:text-primary-600 inline-flex items-center gap-0.5">
                signer<HelpCircle className="h-3 w-3 inline" />
              </button>
              {" "}(safest) or where you save your other passwords (not recommended).
            </p>
          </div>

          {/* nsec display with show/hide and copy */}
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={nsec}
              readOnly
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              className="w-full border border-gray-300 rounded-xl px-4 py-2.5 pr-20 font-mono text-sm focus:outline-none"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={copyNsec}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Copy key"
              >
                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            {!inTauri && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    if ("credentials" in navigator && "PasswordCredential" in window) {
                      const cred = new (window as Window & { PasswordCredential: new (opts: { id: string; password: string; name: string }) => Credential }).PasswordCredential({
                        id: name || "nostr-user",
                        password: nsec,
                        name: name || "Nostr Account",
                      });
                      await navigator.credentials.store(cred);
                    } else {
                      await navigator.clipboard.writeText(nsec);
                    }
                  } catch {
                    try { await navigator.clipboard.writeText(nsec); } catch { /* noop */ }
                  }
                }}
                className="flex-1 flex items-center justify-center gap-1.5 border border-gray-300 hover:bg-gray-50 text-gray-700 font-semibold py-3 px-4 rounded-xl transition-colors"
              >
                <KeyRound className="w-4 h-4" />
                Save to password manager
              </button>
            )}
            <button
              onClick={handleSaved}
              disabled={isCreating || (inTauri && saveKeyToStore && !tauriPassword)}
              className="flex-1 bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-4 rounded-xl transition-colors disabled:opacity-50"
            >
              {isCreating ? "Creating..." : "I've saved it"}
            </button>
          </div>

          {/* Warning */}
          <div className="p-3 bg-amber-50 rounded-xl border border-amber-200">
            <p className="text-xs text-amber-900">
              <span className="font-semibold">Important:</span> There is no "forgot password" — if you lose it, no one can recover it.
            </p>
          </div>

          {/* Tauri: key encryption option */}
          {tauriSaveKeySection}

          {/* 12-word mnemonic backup */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowMnemonic(!showMnemonic)}
              className="w-full flex items-center justify-center gap-1.5 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium py-2.5 px-4 rounded-xl text-sm transition-colors"
            >
              <BookKey className="w-4 h-4" />
              Write down 12 words
            </button>
            {showMnemonic && mnemonic && (
              <div className="p-3 rounded-xl border bg-gray-50 space-y-3">
                <p className="text-xs text-gray-500">
                  These 12 words are another form of the same password. You can write them down and use them to log in later.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {mnemonic.split(" ").map((word, i) => (
                    <div key={`${word}-${i}`} className="flex items-center gap-1.5 text-sm font-mono">
                      <span className="text-gray-400 text-xs w-4 text-right">{i + 1}.</span>
                      <span>{word}</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={copyMnemonicWords}
                  className="w-full flex items-center justify-center gap-1 border border-gray-300 hover:bg-gray-100 text-gray-600 py-1.5 rounded-lg text-xs transition-colors"
                >
                  {mnemonicCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {mnemonicCopied ? "Copied" : "Copy words"}
                </button>
              </div>
            )}
          </div>

          {/* Signer info dialog */}
          {showSignerInfo && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowSignerInfo(false)}>
              <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5" />What is a signer?
                  </h2>
                  <button type="button" onClick={() => setShowSignerInfo(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
                </div>
                <div className="space-y-4 text-sm text-gray-600">
                  <p>
                    A <strong className="text-gray-900">signer</strong> is a small app that holds your secret key and signs on your behalf.
                    No website ever sees your key — they just ask the signer to approve actions.
                  </p>
                  <div className="p-3 bg-amber-50 rounded-xl border border-amber-200">
                    <p className="text-xs text-amber-900">
                      <span className="font-semibold">Why not a password manager?</span> Password managers store secrets in your browser's memory where any code on the page could access them.
                      A signer keeps your key in a separate process or device — even if a website is compromised, your key stays safe.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-medium text-gray-900">Recommended signers for your platform</h3>
                    <div className="p-3 bg-green-50 rounded-xl border border-green-200 space-y-2">
                      <p className="text-xs font-semibold text-green-800">
                        For {topSigner.platform}, we recommend{" "}
                        {topSigner.url ? (
                          <a href={topSigner.url} target="_blank" rel="noopener noreferrer" className="underline">{topSigner.name}</a>
                        ) : topSigner.name}
                      </p>
                    </div>
                    <SignerRecommendations />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-gray-900">How to use a signer</h3>
                    <ol className="list-decimal list-inside space-y-1 text-xs">
                      <li>Install a signer from the list above</li>
                      <li>Import your secret key into the signer</li>
                      <li>Next time you log in, use "Log in with browser extension" or scan a QR code — no need to paste your key</li>
                    </ol>
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-gray-900 flex items-center gap-1">
                      <Smartphone className="h-4 w-4" />Phone signer option
                    </h3>
                    <p className="text-xs">
                      Install a signer on your phone (Amber for Android, Alby Go for iPhone), import your key,
                      and next time you can log in by scanning a QR code from the login page — no key pasting needed.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Why is it so long? dialog */}
          {showWhyLong && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowWhyLong(false)}>
              <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <KeyRound className="w-5 h-5" />Why is the password so long?
                  </h2>
                  <button type="button" onClick={() => setShowWhyLong(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
                </div>
                <div className="space-y-3 text-sm text-gray-600">
                  <p>
                    This site is built on <strong className="text-gray-900">Nostr</strong>, a decentralized protocol.
                    There is no big tech company running a central server — no one can reset your password,
                    but no one can stop you from posting, either.
                  </p>
                  <p>
                    Your password is actually a cryptographic key. It needs to be long because
                    it's the only thing that proves you are you — there's no email, phone number,
                    or recovery flow behind it.
                  </p>
                  <p>
                    If you'd prefer something easier to write down, tap{" "}
                    <strong className="text-gray-900">"Write down 12 words"</strong>{" "}
                    on the previous screen. The 12 words are another form of the same key,
                    designed to be human-friendly.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Render: done (post-signup) ────────────────────────────────── */

  if (step === "done") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full space-y-5">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold text-gray-900">You're in!</h2>
            <p className="text-sm text-gray-500">Your account is ready. Next time you visit, use one of these to log in:</p>
          </div>

          <div className="space-y-2">
            <div className="p-3 rounded-xl border bg-gray-50 space-y-1.5">
              <p className="text-sm font-medium text-gray-900">Log in with nsec password</p>
              <p className="text-xs text-gray-500">Paste the nsec key you just saved.</p>
            </div>
            <div className="p-3 rounded-xl border bg-gray-50 space-y-1.5">
              <p className="text-sm font-medium text-gray-900">Log in with 12 word mnemonic</p>
              <p className="text-xs text-gray-500">Type the 12 words if you wrote them down.</p>
            </div>
            {!inTauri && (
              <div className="p-3 rounded-xl border bg-gray-50 space-y-1.5">
                <p className="text-sm font-medium text-gray-900">Log in with browser extension</p>
                <p className="text-xs text-gray-500">Import your key into a signer extension for the safest option.</p>
              </div>
            )}
          </div>

          <button
            onClick={() => window.location.reload()}
            className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
          >
            Go to Planner
          </button>
        </div>
      </div>
    );
  }

  /* ── Render: main login screen ─────────────────────────────────── */

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full space-y-6">
        {/* Logo + tagline */}
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="bg-primary-100 p-4 rounded-full">
              <Calendar className="w-12 h-12 text-primary-600" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Planner</h1>
          <p className="text-gray-500 text-sm">
            No email needed. Just pick a name and you're in.
          </p>
        </div>

        {/* Extension error banner */}
        {loginView === "main" && extensionError && (
          <div className="p-3 bg-red-50 rounded-xl border border-red-200">
            <p className="text-sm text-red-600">{extensionError}</p>
          </div>
        )}

        {/* ── Main view: signup + login links ────────────────────── */}
        {loginView === "main" && (
          <>
            {/* Signup form */}
            <div className="space-y-3">
              <label htmlFor="name-input" className="block text-sm font-medium text-gray-700">
                Name
              </label>
              <input
                id="name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleStart(); }}
                placeholder="What should we call you?"
                autoFocus
                className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <button
                onClick={handleStart}
                disabled={!name.trim()}
                className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors disabled:opacity-50"
              >
                Start
              </button>
            </div>

            {/* Login method links */}
            <div className="space-y-0.5 pt-2 border-t border-gray-100">
              {!inTauri && (
                <button
                  type="button"
                  onClick={handleExtensionLogin}
                  disabled={extensionLoading}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-2 disabled:opacity-50"
                >
                  <ShieldCheck className="w-3 h-3" />
                  {extensionLoading ? "Connecting..." : "Log in with browser extension"}
                </button>
              )}
              <button
                type="button"
                onClick={() => { switchLoginView("signer"); generateConnectQR(); }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-2"
              >
                <QrCode className="w-3 h-3" />
                Log in with signer (QR code) or bunker
              </button>
              <button
                type="button"
                onClick={() => switchLoginView("mnemonic")}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-2"
              >
                <BookKey className="w-3 h-3" />
                Log in with 12 word mnemonic
              </button>
              <button
                type="button"
                onClick={() => switchLoginView("nsec")}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 py-2"
              >
                <KeyRound className="w-3 h-3" />
                Log in with nsec password
              </button>
            </div>

            {/* Tips */}
            <div className="text-center text-xs text-gray-400 transition-opacity duration-500 px-2 min-h-[2.5rem] flex items-center justify-center">
              {LOGIN_TIPS[tipIndex]}
            </div>

            {/* Security info link */}
            <div className="pt-4 border-t border-gray-100 flex justify-center">
              <button
                type="button"
                onClick={() => setShowSecurityInfo(true)}
                className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
              >
                Security info
              </button>
            </div>
          </>
        )}

        {/* ── Tauri: stored key unlock ───────────────────────────── */}
        {loginView === "unlock" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You have a saved key. Enter your password to unlock.
            </p>
            <input
              type="password"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlockStoredKey()}
              placeholder="Password"
              autoFocus
              className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              autoComplete="off"
            />
            {unlockError && <p className="text-red-500 text-xs">{unlockError}</p>}
            <button
              onClick={handleUnlockStoredKey}
              disabled={unlocking}
              className="w-full flex items-center justify-center gap-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors disabled:opacity-50"
            >
              {unlocking ? <Loader className="w-5 h-5 animate-spin" /> : <Lock className="w-5 h-5" />}
              Unlock
            </button>
            <button
              onClick={() => switchLoginView("main")}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              Use a different key
            </button>
          </div>
        )}

        {/* ── Signer / QR code view ──────────────────────────────── */}
        {loginView === "signer" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => switchLoginView("main")}
              className="flex items-center justify-center w-full gap-1 text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              <ChevronLeft className="w-3 h-3" />Back
            </button>

            <div className="space-y-2">
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-xs text-gray-500 text-center">
                    Scan with your signer app (Amber, Alby Go, etc.)
                  </p>
                  <div className="bg-white p-2 rounded-lg border">
                    <img src={qrDataUrl} alt="Scan with signer app" className="w-56 h-56" />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(connectUri);
                        setConnectCopied(true);
                        setTimeout(() => setConnectCopied(false), 2000);
                      } catch { /* noop */ }
                    }}
                    className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-800 font-medium py-1"
                  >
                    {connectCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {connectCopied ? "Copied" : "Copy URI"}
                  </button>
                </div>
              )}
              {connectWaiting && !qrDataUrl && (
                <div className="flex flex-col items-center gap-3 py-4">
                  <Loader className="w-8 h-8 text-primary-600 animate-spin" />
                  <p className="text-sm text-gray-500">Generating QR code...</p>
                </div>
              )}
              {connectWaiting && qrDataUrl && (
                <p className="text-xs text-center text-gray-500 animate-pulse">Waiting for signer to respond...</p>
              )}
              {connectError && (
                <div className="space-y-2">
                  <p className="text-xs text-red-500 text-center">{connectError}</p>
                  <button
                    onClick={generateConnectQR}
                    className="w-full text-sm text-primary-600 hover:text-primary-800 font-medium py-2"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-white px-2 text-gray-400">Or paste URI</span>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="bunker-input" className="text-xs font-medium text-gray-700 flex items-center gap-1">
                <Link2 className="w-3 h-3" />Bunker / Remote Signer URI
              </label>
              <div className="flex gap-2">
                <input
                  id="bunker-input"
                  value={bunkerUrl}
                  onChange={(e) => setBunkerUrl(e.target.value)}
                  placeholder="bunker://... or nostrconnect://..."
                  className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                  onKeyDown={(e) => { if (e.key === "Enter") handleBunkerLogin(); }}
                />
                <button
                  onClick={handleBunkerLogin}
                  disabled={bunkerLoading}
                  className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors disabled:opacity-50"
                >
                  {bunkerLoading ? "..." : "Go"}
                </button>
              </div>
              {bunkerError && <p className="text-xs text-red-500">{bunkerError}</p>}
            </div>
          </div>
        )}

        {/* ── Mnemonic (NIP-06) view ─────────────────────────────── */}
        {loginView === "mnemonic" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => switchLoginView("main")}
              className="flex items-center justify-center w-full gap-1 text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              <ChevronLeft className="w-3 h-3" />Back
            </button>

            <div className="p-3 bg-amber-50 rounded-xl border border-amber-200">
              <p className="text-xs text-amber-900">
                <span className="font-semibold">Less secure:</span>{" "}
                {inTauri
                  ? "Your seed phrase is entered directly into the app."
                  : "Typing your seed phrase into a web page exposes it to any code running on this site. For better security, try using a browser extension or other external signer."}
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="seed-phrase-input" className="text-xs font-medium text-gray-700">
                Seed phrase (12 or 24 words)
              </label>
              <textarea
                id="seed-phrase-input"
                value={seedPhrase}
                onChange={(e) => setSeedPhrase(e.target.value)}
                placeholder="word1 word2 word3 ..."
                rows={3}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <div className="space-y-1">
                <label htmlFor="seed-passphrase-input" className="text-xs font-medium text-gray-500">
                  Passphrase <span className="font-normal">(optional, only if you set one)</span>
                </label>
                <div className="relative">
                  <input
                    id="seed-passphrase-input"
                    type={showSeedPassphrase ? "text" : "password"}
                    value={seedPassphrase}
                    onChange={(e) => setSeedPassphrase(e.target.value)}
                    placeholder="Leave blank if none"
                    autoComplete="off"
                    className="w-full border border-gray-300 rounded-xl px-4 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSeedPassphrase(!showSeedPassphrase)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600"
                    aria-label={showSeedPassphrase ? "Hide passphrase" : "Show passphrase"}
                  >
                    {showSeedPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {tauriSaveKeySection}
              {seedLoginError && <p className="text-xs text-red-500">{seedLoginError}</p>}
              <button
                onClick={handleSeedLogin}
                disabled={seedLoginLoading}
                className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors disabled:opacity-50"
              >
                {seedLoginLoading ? "Deriving key..." : "Log in"}
              </button>
              <p className="text-xs text-gray-400 text-center">
                Uses derivation path m/44'/1237'/0'/0/0 (NIP-06)
              </p>
            </div>
          </div>
        )}

        {/* ── Nsec password view ─────────────────────────────────── */}
        {loginView === "nsec" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => switchLoginView("main")}
              className="flex items-center justify-center w-full gap-1 text-xs text-gray-500 hover:text-gray-700 py-1"
            >
              <ChevronLeft className="w-3 h-3" />Back
            </button>

            <div className="p-3 bg-amber-50 rounded-xl border border-amber-200">
              <p className="text-xs text-amber-900">
                <span className="font-semibold">Less secure:</span>{" "}
                {inTauri
                  ? "Your key is entered directly into the app."
                  : "Pasting your key into a web page exposes it to any code running on this site. For better security, try using a browser extension or other external signer."}
              </p>
            </div>

            <form ref={loginFormRef} onSubmit={(e) => { e.preventDefault(); handleNsecDirectLogin(); }} className="space-y-3" autoComplete="off">
              <label htmlFor="nsec-login-input" className="text-xs font-medium text-gray-700">Secret key (nsec)</label>
              <input
                id="nsec-login-input"
                name="nsec-login"
                type="password"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={loginNsec}
                onChange={(e) => setLoginNsec(e.target.value)}
                placeholder="nsec1..."
                className="w-full border border-gray-300 rounded-xl px-4 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {tauriSaveKeySection}
              {nsecLoginError && <p className="text-xs text-red-500">{nsecLoginError}</p>}
              <button
                type="submit"
                disabled={nsecLoginLoading}
                className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-6 rounded-xl transition-colors disabled:opacity-50"
              >
                {nsecLoginLoading ? "Logging in..." : "Log in"}
              </button>
            </form>
          </div>
        )}
      </div>

      {/* ── Security info modal ─────────────────────────────────────── */}
      {showSecurityInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setShowSecurityInfo(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5" />How login works
              </h2>
              <button
                type="button"
                onClick={() => setShowSecurityInfo(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-4 text-sm text-gray-600">
              {/* Simple intro */}
              <div className="rounded-xl bg-primary-50 border border-primary-200 p-4 space-y-2">
                <p className="text-gray-900 font-medium">New here? It's simple.</p>
                <p>
                  Just pick a name and hit Start — no email needed. You'll get a secret key
                  to save (like a master password), and that's it. You're in.
                </p>
                <p className="text-xs text-gray-400 italic">
                  That's the easy way, and it works, but it is not the most secure way
                  to use Planner.
                </p>
              </div>

              <p>
                Saving the secret key to your password manager is as secure as a password
                on other sites, but if you are building a business or a personal profile
                you plan to keep around permanently, there are some things you should know.
              </p>

              {/* How Planner is different */}
              <section className="space-y-1.5">
                <h3 className="font-medium text-gray-900">How Planner is different</h3>
                <p>
                  Planner is built on a decentralized protocol called Nostr. You own your
                  account. That means there are no central servers to stop you from posting,
                  and it also means there are none to save your password for you.
                </p>
              </section>

              {/* Why key security matters */}
              <section className="space-y-1.5">
                <h3 className="font-medium text-gray-900">Why key security matters</h3>
                <p>
                  Your secret key is your permanent, irrevocable identity. There is no
                  password reset. If someone obtains your key, they become you — forever.
                  Treat it like a Bitcoin private key, not a website password.
                </p>
              </section>

              {/* How we protect your key */}
              <section className="space-y-2">
                <h3 className="font-medium text-gray-900">How we protect your key</h3>
                <p>
                  Planner lets you paste your secret key directly to log in, but this
                  is the least secure option — your key is held in browser memory where
                  JavaScript can access it. For stronger protection, use one of the
                  alternatives below instead:
                </p>

                {/* NIP-07 */}
                <div className="rounded-xl border border-green-200 bg-green-50/50 p-3 space-y-1.5">
                  <p className="font-medium text-green-800 text-xs uppercase tracking-wide">
                    Browser extension (NIP-07) — for Planner on the web
                  </p>
                  <p>
                    Extensions keep your key in a separate process, isolated from this
                    page's JavaScript by the browser's security boundary.
                  </p>
                  <SignerRecommendations />
                </div>

                {/* NIP-46 */}
                <div className="rounded-xl border border-green-200 bg-green-50/50 p-3 space-y-1.5">
                  <p className="font-medium text-green-800 text-xs uppercase tracking-wide">
                    Bunker / Remote Signer (NIP-46) — for Desktop or Mobile Apps
                  </p>
                  <p>
                    A remote signer keeps your key on a separate device entirely. This site
                    communicates with the signer over encrypted relay messages and only ever
                    receives signatures, never the key itself.
                  </p>
                  <div className="text-xs space-y-1 mt-1">
                    <p>
                      <strong>Android:</strong>{" "}
                      <a href="https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">Amber</a>
                      {" "}(dedicated signer — keys never leave the device)
                    </p>
                    <p>
                      <strong>iPhone:</strong>{" "}
                      <a href="https://apps.apple.com/us/app/alby-go/id6471335774" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">Alby Go</a>
                      {", "}
                      <a href="https://apps.apple.com/us/app/nostur-nostr-client/id1672780508" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">Nostur</a>
                    </p>
                    <p>
                      <strong>Desktop:</strong>{" "}
                      <a href="https://nsecbunker.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">nsecBunker</a>
                      {" (self-hosted or hosted), "}
                      <a href="https://github.com/nbd-wtf/keycast" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-900">Keycast</a>
                      {" (team/shared signing)"}
                    </p>
                  </div>
                </div>
              </section>

              {/* Why not paste a secret key */}
              <section className="space-y-1.5">
                <h3 className="font-medium text-gray-900">Why not just paste a secret key or use a password manager?</h3>
                <p>
                  A web page is dynamically-served code. Every npm dependency, every script
                  on the same origin, and any XSS vulnerability gets full access to the
                  JavaScript memory where a pasted key would live.
                </p>
                <p>
                  An extension or bunker limits the blast radius: even if this site's code
                  were compromised, the attacker gets signatures for one session — not your
                  permanent identity.
                </p>
              </section>

              {/* No account, no server */}
              <section className="space-y-1.5">
                <h3 className="font-medium text-gray-900">No account, no server</h3>
                <p>
                  Nostr has no accounts, emails, or passwords. Your secret key <em>is</em>{" "}
                  your identity. There is no "forgot password" flow. Keep your key backed up
                  securely — if you lose it, no one can recover it for you.
                </p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
