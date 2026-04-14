# Nostr Login Flow Reference

Extracted from corkboards.me — a complete Nostr authentication system supporting key generation, nsec login, NIP-06 seed phrases, NIP-07 browser extensions, NIP-46 remote signers (QR code + bunker URI), and multi-account switching.

## Dependencies

```json
{
  "@nostrify/nostrify": "0.50.5",
  "@nostrify/react": "^0.2.20",
  "nostr-tools": "^2.13.0",
  "qrcode": "^1.5.4",
  "@tanstack/react-query": "^5.56.2"
}
```

UI uses Radix + Tailwind (shadcn/ui). Adapt as needed.

## Architecture Overview

```
App.tsx
  QueryClientProvider          -- TanStack Query
    NostrLoginProvider         -- from @nostrify/react/login, storageKey='app:login'
      NostrProvider            -- NPool relay connection
        <routes>
```

`NostrLoginProvider` persists logins to localStorage. It provides `useNostrLogin()` which gives `{ logins, addLogin, removeLogin, setLogin }`.

## File 1: relayConstants.ts

```ts
/** Last-resort fallback relays for bootstrapping. */
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://antiprimal.net',
];

/** Signaling relay for NIP-46 remote signer negotiation. */
export const NOSTRCONNECT_RELAY = 'wss://nos.lol';
```

## File 2: useLoginActions.ts — Core login/logout logic

```ts
import { useNostr } from '@nostrify/react';
import { NLogin, useNostrLogin } from '@nostrify/react/login';
import { NConnectSigner, NRelay1, NSecSigner } from '@nostrify/nostrify';
import { generateSecretKey, getPublicKey, nip19, nip04 } from 'nostr-tools';
import { NOSTRCONNECT_RELAY } from './relayConstants';

export function useLoginActions() {
  const { nostr } = useNostr();
  const { logins, addLogin, removeLogin } = useNostrLogin();

  return {
    // --- Method 1: Direct nsec login ---
    nsec(nsec: string): void {
      const login = NLogin.fromNsec(nsec);
      addLogin(login);
    },

    // --- Method 2: Bunker URI login (NIP-46) ---
    async bunker(uri: string): Promise<void> {
      const login = await NLogin.fromBunker(uri, nostr);
      addLogin(login);
    },

    // --- Method 3: Browser extension login (NIP-07) ---
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addLogin(login);
    },

    // --- Method 4: QR code login (NIP-46 nostrconnect://) ---
    // Generates a nostrconnect:// URI, returns it via onUri callback,
    // then waits for the remote signer to respond.
    async nostrconnect(signal: AbortSignal, onUri: (uri: string) => void): Promise<void> {
      const sk = generateSecretKey();
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);
      const secret = crypto.randomUUID().slice(0, 8);
      const relayUrl = NOSTRCONNECT_RELAY;

      const params = new URLSearchParams();
      params.append('relay', relayUrl);
      params.append('secret', secret);
      params.append('name', 'YourAppName');

      const uri = `nostrconnect://${clientPubkey}?${params.toString()}`;
      onUri(uri);

      // Open direct relay connection
      const relay = new NRelay1(relayUrl, { idleTimeout: false });
      const sub = relay.req(
        [{ kinds: [24133], '#p': [clientPubkey] }],
        { signal },
      );

      let bunkerPubkey: string | null = null;
      for await (const msg of sub) {
        if (msg[0] === 'CLOSED') throw new Error('Subscription closed');
        if (msg[0] === 'EVENT') {
          const event = msg[2];
          try {
            let decrypted: string;
            try {
              decrypted = nip04.decrypt(sk, event.pubkey, event.content);
            } catch {
              decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
            }
            const response = JSON.parse(decrypted);
            if (response.result === secret) {
              bunkerPubkey = event.pubkey;
              break;
            }
          } catch { /* not our response */ }
        }
      }

      if (!bunkerPubkey) throw new Error('No response from signer');

      const signer = new NConnectSigner({
        relay,
        pubkey: bunkerPubkey,
        signer: clientSigner,
        timeout: 60_000,
      });
      const userPubkey = await signer.getPublicKey();

      const login = new NLogin('bunker', userPubkey, {
        bunkerPubkey,
        clientNsec,
        relays: [relayUrl],
      });
      addLogin(login);
    },

    // --- Method 5: Amber deep link (Android NIP-46) ---
    async amberConnect(signal?: AbortSignal): Promise<void> {
      const sk = generateSecretKey();
      const clientPubkey = getPublicKey(sk);
      const clientNsec = nip19.nsecEncode(sk);
      const clientSigner = new NSecSigner(sk);
      const secret = crypto.randomUUID().slice(0, 8);
      const connectRelays = [NOSTRCONNECT_RELAY];

      const params = new URLSearchParams();
      for (const r of connectRelays) params.append('relay', r);
      params.append('secret', secret);
      params.append('name', 'YourAppName');
      params.append('url', 'https://yourapp.com');
      params.append('perms', 'get_public_key,sign_event,nip04_encrypt,nip04_decrypt,nip44_encrypt,nip44_decrypt');

      const relays = connectRelays.map(url => new NRelay1(url, { idleTimeout: false }));
      const subs = relays.map(relay =>
        relay.req([{ kinds: [24133], '#p': [clientPubkey] }], { signal })
      );

      const responsePromise = new Promise<string>((resolve, reject) => {
        let resolved = false;
        signal?.addEventListener('abort', () => { if (!resolved) reject(new Error('aborted')); });

        for (const sub of subs) {
          (async () => {
            try {
              for await (const msg of sub) {
                if (resolved) return;
                if (msg[0] === 'EVENT') {
                  const event = msg[2];
                  try {
                    let decrypted: string;
                    try {
                      decrypted = nip04.decrypt(sk, event.pubkey, event.content);
                    } catch {
                      decrypted = await clientSigner.nip44!.decrypt(event.pubkey, event.content);
                    }
                    const response = JSON.parse(decrypted);
                    if (response.result === secret) {
                      resolved = true;
                      resolve(event.pubkey);
                      return;
                    }
                  } catch { /* not our response */ }
                }
              }
            } catch { /* subscription closed */ }
          })();
        }
      });

      // Trigger Amber on Android, or generic deep link on other platforms
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        const fallback = encodeURIComponent('https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner');
        window.location.href = `intent://${clientPubkey}?${params.toString()}#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;S.browser_fallback_url=${fallback};end`;
      } else {
        const a = document.createElement('a');
        a.href = `nostrconnect://${clientPubkey}?${params.toString()}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      const bunkerPubkey = await responsePromise;

      const signer = new NConnectSigner({
        relay: relays[0],
        pubkey: bunkerPubkey,
        signer: clientSigner,
        timeout: 60_000,
      });
      const userPubkey = await signer.getPublicKey();

      const login = new NLogin('bunker', userPubkey, {
        bunkerPubkey,
        clientNsec,
        relays: connectRelays,
      });
      addLogin(login);
    },

    // --- Logout ---
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
        removeLogin(login.id);
        sessionStorage.clear();
        try { document.dispatchEvent(new Event('nlLogout')); } catch {}
        window.location.reload();
      }
    },
  };
}
```

## File 3: useCurrentUser.ts — Convert login state to usable NUser

```ts
import { type NLoginType, NUser, useNostrLogin } from '@nostrify/react/login';
import { useNostr } from '@nostrify/react';
import { useCallback, useMemo } from 'react';

export function useCurrentUser() {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  const loginToUser = useCallback((login: NLoginType): NUser => {
    switch (login.type) {
      case 'nsec':
        return NUser.fromNsecLogin(login);
      case 'bunker':
        return NUser.fromBunkerLogin(login, nostr);
      case 'extension':
        return NUser.fromExtensionLogin(login);
      default:
        throw new Error(`Unsupported login type: ${login.type}`);
    }
  }, [nostr]);

  const users = useMemo(() => {
    const result: NUser[] = [];
    for (const login of logins) {
      try { result.push(loginToUser(login)); } catch {}
    }
    return result;
  }, [logins, loginToUser]);

  const user = users[0] as NUser | undefined;

  return { user, users };
}
```

## File 4: useLoggedInAccounts.ts — Multi-account management

```ts
import { useCallback } from 'react';
import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery } from '@tanstack/react-query';
import { NSchema as n, NostrEvent, NostrMetadata } from '@nostrify/nostrify';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { logins, setLogin: rawSetLogin, removeLogin } = useNostrLogin();

  // Fetch kind:0 profile metadata for all logged-in accounts
  const { data: authors = [] } = useQuery({
    queryKey: ['nostr', 'logins', logins.map((l) => l.id).join(';')],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [0], authors: logins.map((l) => l.pubkey) }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) },
      );
      return logins.map(({ id, pubkey }): Account => {
        const event = events.find((e) => e.pubkey === pubkey);
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event?.content);
          return { id, pubkey, metadata, event };
        } catch {
          return { id, pubkey, metadata: {}, event };
        }
      });
    },
    retry: 3,
  });

  const currentUser = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  const otherUsers = (authors || []).slice(1) as Account[];

  const setLogin = useCallback((loginId: string) => {
    rawSetLogin(loginId);
    // Reload to ensure clean state when switching accounts
    window.location.reload();
  }, [rawSetLogin]);

  return { authors, currentUser, otherUsers, setLogin, removeLogin };
}
```

## File 5: SignerRecommendations.tsx — Platform-aware signer suggestions

```tsx
interface SignerRec {
  name: string;
  note: string;
  url?: string;
}

const MOBILE_SIGNERS: Record<string, SignerRec[]> = {
  iPhone: [
    { name: 'Alby Go', note: 'Nostr signer and Lightning wallet', url: 'https://apps.apple.com/us/app/alby-go/id6471335774' },
  ],
  Android: [
    { name: 'Amber', note: 'Dedicated signer app (recommended)', url: 'https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner' },
    { name: 'Amethyst', note: 'Full Nostr client with built-in key management', url: 'https://play.google.com/store/apps/details?id=com.vitorpamplona.amethyst' },
  ],
};

const BROWSER_SIGNERS: Record<string, SignerRec[]> = {
  Chrome: [
    { name: 'nos2x', note: 'Lightweight, open-source', url: 'https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp' },
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Firefox: [
    { name: 'nos2x-fox', note: 'Firefox port of nos2x', url: 'https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/' },
  ],
  Brave: [
    { name: 'nos2x', note: 'Chrome extensions work in Brave', url: 'https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp' },
  ],
  Edge: [
    { name: 'nostr-keyx', note: 'Uses OS keychain or YubiKey', url: 'https://github.com/nicol-ograve/nicol-ograve.github.io/releases/tag/nostr-keyx-v1.0.4' },
  ],
  Safari: [
    { name: 'Alby Go', note: 'Nostr signer and Lightning wallet', url: 'https://apps.apple.com/us/app/alby-go/id6471335774' },
  ],
};

function detectPlatform(): { isMobile: boolean; platform: string } {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return { isMobile: true, platform: 'iPhone' };
  if (/Android/.test(ua)) return { isMobile: true, platform: 'Android' };
  if (/Firefox/.test(ua)) return { isMobile: false, platform: 'Firefox' };
  if (/Edg\//.test(ua)) return { isMobile: false, platform: 'Edge' };
  if (/OPR\//.test(ua)) return { isMobile: false, platform: 'Opera' };
  if (/Brave/.test(ua)) return { isMobile: false, platform: 'Brave' };
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return { isMobile: false, platform: 'Safari' };
  if (/Chrome/.test(ua)) return { isMobile: false, platform: 'Chrome' };
  return { isMobile: false, platform: 'Chrome' };
}

export { detectPlatform, MOBILE_SIGNERS, BROWSER_SIGNERS };

export function getSignerRecommendation(): string {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers) return `No Nostr signer found. On ${platform}, try ${signers.map(s => s.name).join(' or ')}.`;
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers) return `No Nostr extension found. For ${platform}, install ${signers.map(s => s.name).join(' or ')}.`;
  return 'No Nostr extension found. Install a NIP-07 browser extension like nos2x or nos2x-fox.';
}

export function getTopSignerForPlatform(): { name: string; url?: string; isMobile: boolean; platform: string } {
  const { isMobile, platform } = detectPlatform();
  if (isMobile) {
    const signers = MOBILE_SIGNERS[platform];
    if (signers?.[0]) return { ...signers[0], isMobile, platform };
  }
  const signers = BROWSER_SIGNERS[platform];
  if (signers?.[0]) return { ...signers[0], isMobile, platform };
  return { name: 'nos2x', url: 'https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp', isMobile, platform };
}
```

## File 6: WelcomePage.tsx — Full login/signup UI (main page)

This is the primary login page shown to unauthenticated users. It supports:

1. **Signup**: Enter name -> generate NIP-06 seed phrase + nsec -> backup screen with download/copy/12-word mnemonic -> publish kind:0 profile
2. **Login with nsec**: Paste saved secret key
3. **Login with 12-word mnemonic (NIP-06)**: Enter seed phrase + optional passphrase
4. **Login with browser extension (NIP-07)**: One-click if `window.nostr` exists
5. **Login with QR code (NIP-46)**: Generates nostrconnect:// URI, shows QR, waits for signer response
6. **Login with bunker URI**: Paste bunker:// or nostrconnect:// directly

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { Eye, EyeOff, Copy, Check, ChevronLeft, Link2, ShieldCheck, KeyRound, Download, QrCode, Smartphone, HelpCircle, BookKey } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/useToast';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { privateKeyFromSeedWords, validateWords, generateSeedWords } from 'nostr-tools/nip06';
import { SignerRecommendations, getSignerRecommendation, getTopSignerForPlatform } from './SignerRecommendations';
import QRCode from 'qrcode';

type Step = 'name' | 'key-backup' | 'done';
type LoginView = 'main' | 'nsec' | 'mnemonic' | 'signer';

interface WelcomePageProps {
  onClose?: () => void; // If provided, renders in dialog mode (for "add account")
}

export function WelcomePage({ onClose }: WelcomePageProps = {}) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [loginView, setLoginView] = useState<LoginView>('main');
  const [bunkerUrl, setBunkerUrl] = useState('');
  const [bunkerLoading, setBunkerLoading] = useState(false);
  const [bunkerError, setBunkerError] = useState<string | null>(null);
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);
  const [showSignerInfo, setShowSignerInfo] = useState(false);
  const [showWhyLong, setShowWhyLong] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicCopied, setMnemonicCopied] = useState(false);
  const [connectUri, setConnectUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectWaiting, setConnectWaiting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);
  const connectAbortRef = useRef<AbortController | null>(null);
  const [loginNsec, setLoginNsec] = useState('');
  const [nsecLoginLoading, setNsecLoginLoading] = useState(false);
  const [nsecLoginError, setNsecLoginError] = useState<string | null>(null);
  const [seedPhrase, setSeedPhrase] = useState('');
  const [seedPassphrase, setSeedPassphrase] = useState('');
  const [showSeedPassphrase, setShowSeedPassphrase] = useState(false);
  const [seedLoginLoading, setSeedLoginLoading] = useState(false);
  const [seedLoginError, setSeedLoginError] = useState<string | null>(null);
  const passwordFormRef = useRef<HTMLFormElement>(null);

  const login = useLoginActions();
  const { mutateAsync: publishEvent, isPending: isPublishing } = useNostrPublish();
  const isDialog = !!onClose;

  // Reset state when dialog opens
  useEffect(() => {
    if (isDialog) {
      setStep('name');
      setName('');
      setNsec('');
      setShowKey(false);
      setCopied(false);
      setLoginView('main');
      setBunkerUrl('');
      setShowSecurityInfo(false);
    }
  }, [isDialog]);

  // --- Signup: generate key from seed phrase ---
  const handleStart = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast({ title: 'Name required', description: 'Please enter a name to get started.', variant: 'destructive' });
      return;
    }
    const words = generateSeedWords();
    const sk = privateKeyFromSeedWords(words);
    setMnemonic(words);
    setNsec(nip19.nsecEncode(sk));
    setStep('key-backup');
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(nsec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  // --- Complete signup: log in + publish profile ---
  const handleSaved = async () => {
    setIsLoading(true);
    try {
      // Prompt browser password manager to save
      try {
        if ((window as any).PasswordCredential) {
          const cred = new (window as any).PasswordCredential({
            id: name.trim() || 'nostr-user',
            password: nsec,
            name: name.trim() || 'nostr-user',
          });
          await navigator.credentials.store(cred);
        } else {
          passwordFormRef.current?.requestSubmit();
        }
      } catch {}

      login.nsec(nsec);

      // Publish kind:0 profile metadata
      try {
        if (name) await publishEvent({ kind: 0, content: JSON.stringify({ name: name.trim() }) });
      } catch {}

      if (isDialog) {
        onClose?.();
      } else {
        setStep('done');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // --- NIP-07 browser extension login ---
  const handleExtensionLogin = async () => {
    setExtensionLoading(true);
    setExtensionError(null);
    try {
      if (!('nostr' in window)) throw new Error(getSignerRecommendation());
      await login.extension();
      onClose?.();
    } catch (e: unknown) {
      setExtensionError((e as Error).message || 'Extension login failed');
    } finally {
      setExtensionLoading(false);
    }
  };

  // --- Bunker URI login ---
  const handleBunkerLogin = async () => {
    const trimmedUrl = bunkerUrl.trim();
    if (!trimmedUrl) { setBunkerError('Please enter a bunker or nostrconnect URL'); return; }
    setBunkerLoading(true);
    setBunkerError(null);
    try {
      if (!trimmedUrl.startsWith('bunker://') && !trimmedUrl.startsWith('nostrconnect://')) {
        throw new Error('Invalid bunker URL. It should start with bunker:// or nostrconnect://');
      }
      await login.bunker(trimmedUrl);
      onClose?.();
    } catch (e: unknown) {
      setBunkerError((e as Error).message || 'Bunker login failed');
    } finally {
      setBunkerLoading(false);
    }
  };

  // --- QR code login (nostrconnect://) ---
  const generateConnectQR = useCallback(async () => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;
    setConnectError(null);
    setConnectWaiting(true);
    setConnectUri('');
    setQrDataUrl('');
    try {
      await login.nostrconnect(controller.signal, async (uri) => {
        setConnectUri(uri);
        const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 2 });
        if (!controller.signal.aborted) setQrDataUrl(dataUrl);
      });
      onClose?.();
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const msg = (e as Error).message || 'Connection failed';
      if (!msg.includes('abort')) setConnectError(msg);
    } finally {
      if (!controller.signal.aborted) setConnectWaiting(false);
    }
  }, [login, onClose]);

  useEffect(() => {
    return () => { connectAbortRef.current?.abort(); };
  }, []);

  // --- Direct nsec login ---
  const handleNsecDirectLogin = async () => {
    const trimmed = loginNsec.trim();
    if (!trimmed) { setNsecLoginError('Please enter your nsec key'); return; }
    if (!trimmed.startsWith('nsec1')) { setNsecLoginError('Invalid key - must start with nsec1'); return; }
    setNsecLoginLoading(true);
    setNsecLoginError(null);
    try {
      login.nsec(trimmed);
      onClose?.();
    } catch (e: unknown) {
      setNsecLoginError((e as Error).message || 'Login failed');
    } finally {
      setNsecLoginLoading(false);
    }
  };

  // --- NIP-06 seed phrase login ---
  const handleSeedLogin = () => {
    const words = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!words) { setSeedLoginError('Please enter your seed phrase'); return; }
    if (!validateWords(words)) { setSeedLoginError('Invalid seed phrase'); return; }
    setSeedLoginLoading(true);
    setSeedLoginError(null);
    try {
      const privateKey = privateKeyFromSeedWords(words, seedPassphrase || undefined);
      login.nsec(nip19.nsecEncode(privateKey));
      onClose?.();
    } catch (e: unknown) {
      setSeedLoginError((e as Error).message || 'Failed to derive key');
    } finally {
      setSeedLoginLoading(false);
    }
  };

  // --- UI RENDERING ---
  // (Adapt the JSX below to your UI framework)

  const nameScreen = (
    <>
      <div className="space-y-2">
        <label htmlFor="name-input" className="text-sm font-medium">Name</label>
        <Input
          id="name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should we call you?"
          onKeyDown={(e) => { if (e.key === 'Enter') handleStart(); }}
          autoFocus
        />
      </div>
      <Button className="w-full h-11" onClick={handleStart} disabled={!name.trim()}>Start</Button>
    </>
  );

  // Key backup screen (shown after name entry)
  const keyBackupContent = (
    <div className="space-y-5">
      {/* Hidden form to prompt browser password save */}
      <iframe name="pw-sink" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
      <form ref={passwordFormRef} method="POST" action="about:blank" target="pw-sink"
        style={{ position: 'absolute', left: '-9999px', top: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}>
        <input type="text" name="username" value={name || 'nostr-user'} autoComplete="username" onChange={() => {}} />
        <input type="password" name="password" value={nsec} autoComplete="new-password" onChange={() => {}} />
        <button type="submit" />
      </form>

      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold">Save your password</h2>
        <p className="text-muted-foreground text-sm">This is your password. Save it in your signer (safest) or password manager.</p>
      </div>

      {/* nsec display with show/hide and copy */}
      <div className="relative">
        <Input type={showKey ? 'text' : 'password'} value={nsec} readOnly className="pr-20 font-mono text-sm" />
        <div className="absolute right-0 top-0 h-full flex items-center gap-0.5 pr-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowKey(!showKey)}>
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copyKey}>
            {copied ? <Check className="h-4 w-4 text-purple-500" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={handleSaved} disabled={isLoading || isPublishing}>
          {isLoading || isPublishing ? 'Creating...' : 'Save to password manager'}
        </Button>
        <Button className="flex-1" onClick={handleSaved} disabled={isLoading || isPublishing}>
          {isLoading || isPublishing ? 'Creating...' : "I've saved it"}
        </Button>
      </div>

      <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
        <p className="text-xs text-amber-900 dark:text-amber-300">
          <span className="font-semibold">Important:</span> There is no "forgot password" - if you lose it, no one can recover it.
        </p>
      </div>

      {/* 12-word mnemonic backup option */}
      <div className="space-y-2">
        <Button variant="outline" onClick={() => setShowMnemonic(!showMnemonic)} className="w-full gap-1.5">
          <BookKey className="h-4 w-4" />Write down 12 words
        </Button>
        {showMnemonic && mnemonic && (
          <div className="p-3 rounded-lg border bg-muted/30 space-y-3">
            <p className="text-xs text-muted-foreground">
              These 12 words are another form of the same password. Write them down to log in later.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {mnemonic.split(' ').map((word, i) => (
                <div key={i} className="flex items-center gap-1.5 text-sm font-mono">
                  <span className="text-muted-foreground text-xs w-4 text-right">{i + 1}.</span>
                  <span>{word}</span>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="w-full text-xs gap-1"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(mnemonic);
                  setMnemonicCopied(true);
                  setTimeout(() => setMnemonicCopied(false), 2000);
                } catch { toast({ title: 'Copy failed', variant: 'destructive' }); }
              }}>
              {mnemonicCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {mnemonicCopied ? 'Copied' : 'Copy words'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  // Route to correct step
  if (step === 'key-backup') {
    if (isDialog) return <div className="w-full max-w-md mx-auto">{keyBackupContent}</div>;
    return <div className="min-h-screen flex items-center justify-center p-4"><div className="w-full max-w-md">{keyBackupContent}</div></div>;
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-5 text-center">
          <h2 className="text-2xl font-bold">You're in!</h2>
          <p className="text-muted-foreground text-sm">Your account is ready.</p>
          <Button className="w-full h-11" onClick={() => window.location.reload()}>Continue</Button>
        </div>
      </div>
    );
  }

  // Main login/signup view
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">YourAppName</h1>
          <p className="text-muted-foreground">No email needed. Just pick a name and you're in.</p>
        </div>

        {loginView === 'main' && extensionError && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-200">
            <p className="text-sm text-red-600">{extensionError}</p>
          </div>
        )}

        {loginView === 'main' && nameScreen}

        {/* Login method links */}
        {loginView === 'main' && (
          <div className="space-y-1">
            <button type="button" onClick={handleExtensionLogin} disabled={extensionLoading}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2 disabled:opacity-50">
              <ShieldCheck className="h-3 w-3 inline mr-1" />
              {extensionLoading ? 'Connecting...' : 'Log in with browser extension'}
            </button>
            <button type="button" onClick={() => { setLoginView('signer'); generateConnectQR(); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2">
              <QrCode className="h-3 w-3 inline mr-1" />Log in with signer (QR code) or bunker
            </button>
            <button type="button" onClick={() => setLoginView('mnemonic')}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2">
              <BookKey className="h-3 w-3 inline mr-1" />Log in with 12 word mnemonic
            </button>
            <button type="button" onClick={() => setLoginView('nsec')}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2">
              <KeyRound className="h-3 w-3 inline mr-1" />Log in with nsec password
            </button>
          </div>
        )}

        {/* Signer / QR code view */}
        {loginView === 'signer' && (
          <div className="space-y-4 pt-2 border-t">
            <button type="button"
              onClick={() => { connectAbortRef.current?.abort(); setLoginView('main'); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1">
              <ChevronLeft className="h-3 w-3 inline mr-1" />Back
            </button>
            {qrDataUrl && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-muted-foreground">Scan with your signer app</p>
                <div className="bg-white p-2 rounded-lg">
                  <img src={qrDataUrl} alt="Scan with signer" className="w-56 h-56" />
                </div>
                <Button variant="outline" size="sm" className="text-xs gap-1"
                  onClick={async () => {
                    await navigator.clipboard.writeText(connectUri);
                    setConnectCopied(true);
                    setTimeout(() => setConnectCopied(false), 2000);
                  }}>
                  {connectCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {connectCopied ? 'Copied' : 'Copy URI'}
                </Button>
              </div>
            )}
            {connectWaiting && <p className="text-xs text-center text-muted-foreground animate-pulse">Waiting for signer...</p>}
            {connectError && <p className="text-xs text-red-500 text-center">{connectError}</p>}

            <div className="space-y-2">
              <Label className="text-xs font-medium"><Link2 className="h-3 w-3 inline mr-1" />Bunker URI</Label>
              <div className="flex gap-2">
                <Input value={bunkerUrl} onChange={(e) => setBunkerUrl(e.target.value)}
                  placeholder="bunker://... or nostrconnect://..." className="text-sm font-mono"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleBunkerLogin(); }} />
                <Button onClick={handleBunkerLogin} disabled={bunkerLoading} size="sm">
                  {bunkerLoading ? '...' : 'Go'}
                </Button>
              </div>
              {bunkerError && <p className="text-xs text-red-500">{bunkerError}</p>}
            </div>
          </div>
        )}

        {/* Mnemonic (NIP-06) view */}
        {loginView === 'mnemonic' && (
          <div className="space-y-4 pt-2 border-t">
            <button type="button" onClick={() => setLoginView('main')}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1">
              <ChevronLeft className="h-3 w-3 inline mr-1" />Back
            </button>
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <p className="text-xs text-amber-900">
                <span className="font-semibold">Less secure:</span> Typing your seed phrase into a web page exposes it.
                For better security, use a browser extension or signer.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-medium">Seed phrase (12 or 24 words)</Label>
              <textarea value={seedPhrase} onChange={(e) => setSeedPhrase(e.target.value)}
                placeholder="word1 word2 word3 ..." rows={3} spellCheck={false} autoComplete="off"
                className="w-full rounded-md border px-3 py-2 text-sm font-mono resize-none" />
              <Label className="text-xs font-medium text-muted-foreground">
                Passphrase <span className="font-normal">(optional)</span>
              </Label>
              <Input type={showSeedPassphrase ? 'text' : 'password'} value={seedPassphrase}
                onChange={(e) => setSeedPassphrase(e.target.value)} placeholder="Leave blank if none" className="text-sm" />
              {seedLoginError && <p className="text-xs text-red-500">{seedLoginError}</p>}
              <Button className="w-full" onClick={handleSeedLogin} disabled={seedLoginLoading}>
                {seedLoginLoading ? 'Deriving key...' : 'Log in'}
              </Button>
              <p className="text-xs text-muted-foreground text-center">Uses derivation path m/44'/1237'/0'/0/0 (NIP-06)</p>
            </div>
          </div>
        )}

        {/* Nsec password view */}
        {loginView === 'nsec' && (
          <div className="space-y-4 pt-2 border-t">
            <button type="button" onClick={() => setLoginView('main')}
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1">
              <ChevronLeft className="h-3 w-3 inline mr-1" />Back
            </button>
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <p className="text-xs text-amber-900">
                <span className="font-semibold">Less secure:</span> Pasting your key into a web page exposes it.
                For better security, use a browser extension or signer.
              </p>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleNsecDirectLogin(); }} className="space-y-2">
              <input type="text" name="username" value="nostr-user" autoComplete="username" className="hidden" readOnly />
              <Label className="text-xs font-medium">Secret key (nsec)</Label>
              <Input name="password" type="password" autoComplete="current-password"
                value={loginNsec} onChange={(e) => setLoginNsec(e.target.value)}
                placeholder="nsec1..." className="font-mono text-sm" />
              {nsecLoginError && <p className="text-xs text-red-500">{nsecLoginError}</p>}
              <Button type="submit" className="w-full" disabled={nsecLoginLoading}>
                {nsecLoginLoading ? 'Logging in...' : 'Log in'}
              </Button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
```

## File 7: AccountSwitcher.tsx — Multi-account dropdown

```tsx
import { ChevronDown, LogOut, UserIcon, UserPlus } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';

interface AccountSwitcherProps {
  onAddAccountClick: () => void;
}

export function AccountSwitcher({ onAddAccountClick }: AccountSwitcherProps) {
  const { currentUser, otherUsers, setLogin, removeLogin } = useLoggedInAccounts();
  if (!currentUser) return null;

  const getDisplayName = (account: Account): string =>
    account.metadata.name ?? account.pubkey.slice(0, 8);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 p-1.5 rounded-full hover:bg-accent w-full">
          <Avatar className="w-7 h-7">
            <AvatarImage src={currentUser.metadata.picture} alt={getDisplayName(currentUser)} />
            <AvatarFallback>{getDisplayName(currentUser).charAt(0)}</AvatarFallback>
          </Avatar>
          <p className="font-medium text-xs truncate">{getDisplayName(currentUser)}</p>
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 p-2">
        <div className="font-medium text-sm px-2 py-1.5">Switch Account</div>
        {otherUsers.map((user) => (
          <DropdownMenuItem key={user.id} onClick={() => setLogin(user.id)} className="flex items-center gap-2 cursor-pointer p-2">
            <Avatar className="w-8 h-8">
              <AvatarImage src={user.metadata.picture} />
              <AvatarFallback>{getDisplayName(user).charAt(0)}</AvatarFallback>
            </Avatar>
            <p className="text-sm font-medium">{getDisplayName(user)}</p>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAddAccountClick} className="flex items-center gap-2 cursor-pointer p-2">
          <UserPlus className="w-4 h-4" /><span>Add another account</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => removeLogin(currentUser.id)} className="flex items-center gap-2 cursor-pointer p-2 text-red-500">
          <LogOut className="w-4 h-4" /><span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## App.tsx Provider Setup

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NostrLoginProvider } from '@nostrify/react/login';
import { NostrProvider } from './NostrProvider'; // Your relay pool setup

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NostrLoginProvider storageKey="yourapp:login">
        <NostrProvider>
          {/* Your routes/app content here */}
          {/* Use useCurrentUser() to check auth state */}
          {/* Show <WelcomePage /> when not logged in */}
        </NostrProvider>
      </NostrLoginProvider>
    </QueryClientProvider>
  );
}
```

## NIP Support Summary

| NIP | Purpose | Where Used |
|-----|---------|-----------|
| NIP-01 | Basic protocol, kind:0 profiles | Profile publish on signup |
| NIP-04 | Encryption | Bunker response decryption |
| NIP-06 | Seed phrase (BIP-39 mnemonic) | Signup key gen, mnemonic login |
| NIP-07 | Browser extension (`window.nostr`) | Extension login |
| NIP-19 | Bech32 encoding (nsec, npub) | All key handling |
| NIP-44 | Encryption v2 | Fallback for NIP-46 comms |
| NIP-46 | Remote signer (bunker://, nostrconnect://) | QR login, bunker login, Amber |

## Key Security Decisions

1. **Browser password manager integration**: Hidden form + PasswordCredential API prompts the browser to save the nsec as a password
2. **Security warnings**: Every direct key entry method shows a "less secure" warning recommending extension/signer instead
3. **Session isolation**: `window.location.reload()` on account switch ensures no stale state leaks between accounts
4. **No server**: Keys never leave the client; no backend auth endpoints exist
