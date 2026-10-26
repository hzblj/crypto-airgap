# example

The example app for `@hzblj/crypto-airgap` and its chain packages: one phone as an offline signer, as a watch-only
wallet, or both at once, over QR codes, on test networks. Built from `@hzblj/kara-ui` like every hzblj example.
Private; never published. The engine is `@hzblj/nitro-crypto` from npm.

| Path | What it is |
| --- | --- |
| `app/(tabs)/` | Native tabs (`Tabs` from `@hzblj/kara-ui/router`), each a stack with a large title: Signer (`(signer)`: index, scan, airgap-review, pair, recovery-phrase), Watch-only, Loopback. Route files only re-export a screen from `src/`. |
| `app/onboarding/` | A modal stack: create (the engine generates the phrase), import, protect. The phrase travels between steps in `OnboardingProvider`, never in route params. |
| `src/features/` | One folder per area, each a screen and the components only it uses, behind an `index.ts`: `signer` (the accounts, security, the welcome, the recovery phrase), `airgap` (the signer's flows: pair, scan, review with `request-details`, sign), `watch` (pair with a signer, balances, build a payment, scan the answer, broadcast), `loopback` (both sides in one process with a demo key), `lock`, `onboarding`. |
| `src/components/` | Shared UI: `Page`, `Section`, `Rows`, `Card`, `Value`, `Pill`, `Notice`, `ActionButton`, `PhraseGrid`, `QrCode` (views over `qrcode-generator`, alphanumeric for URs), `AnimatedQr` (a UR's multipart parts on the app's own timer), `QrScanner` (`expo-camera`, with paste as the simulator's way in), `TabStack`, `CopyProvider`. |
| `src/core/` | The signer's core, the only code that holds the seed: `chains.ts` (the adapters on Sepolia, testnet4 and devnet, the account paths), `engine.ts` (the engine and services, once per run), `keychain.ts` (the phrase in `expo-secure-store` behind Face ID or the passcode), `session.ts` (start-up, unlock, lock, create, remove; extended public keys and accounts derived on demand for scanned requests), `airgap.ts` (the pairing codes, reading and signing scanned requests, reading a pairing). |
| `src/store/` | Zustand stores in the `core-store` pattern: `persist(immer(...))`, a slice per concern, selectors from `auto-zustand-selectors-hook`. `wallet` (persisted: the record, auto-lock), `session` (not persisted: locked or not, the accounts, the app state), `airgap` (not persisted: the scanned request under review, the signer the Watch-only tab paired with). `storage.ts` is MMKV with AES-256; its key is 24 bytes from the engine's CSPRNG, kept in the Keychain. |
| `src/hooks/` | `use-wallet.ts` (start-up and auto-lock, the selector hooks), `use-ur-scanner.ts` (scanned strings into one UR, whole or in parts). |
| `src/services/` | The Watch-only tab's network, one file per chain: JSON-RPC (Sepolia, devnet), Esplora (testnet4). A balance, and `airgapQuote`: a payment built from the network's state as a request for the signer, and its answer checked and broadcast. The Signer tab uses none of it. |
| `src/config/` | `networks.ts` (endpoints, explorers, faucets), `theme.ts` (the indigo accent). |
| `assets/icons/` | Material Symbols SVGs, only those the app uses, turned into native assets by kara's plugin at prebuild; `native-icons.d.ts` is written from them (`npx native-icons ./assets/icons`). |
| `assets/app.icon`, `assets/icon.png`, `assets/adaptive-icon.png` | The app icon: an Icon Composer document (a wallet with a QR code, Liquid Glass) for iOS; the same shapes on an indigo gradient as the fallback, and alone on `ICON_BACKGROUND` for Android. Apart from the Nitro Wallet example's emerald one, as are its name, bundle id and scheme, so both install side by side. |

**Folders are layers, and imports point down.** `features` may use every other folder; `hooks` use `core`, `store`,
`config` and `utils`; `core` uses `services` and `store`; `services` use `config` and `utils`; `components`,
`config` and `utils` use nothing of the app's (types aside). Across folders, import a folder's `index.ts`; inside one,
the sibling file. The one exception is `store/storage-key.ts`, which takes `core/engine` directly.

**The Signer tab needs no network.** It reads, shows and signs; nothing in `features/signer` or `features/airgap`
imports `services/`. Only the Watch-only tab talks to the test networks.

**Two phones, or one.** A phone with keys is the signer: Signer, Pair shows its account keys for another phone's
Watch-only tab (`crypto-multi-accounts`), Sparrow (`crypto-account`) or MetaMask (`crypto-hdkey`); Scan to sign reads a
request for any address of those accounts, shows what it does from the bytes to be signed, signs after Face ID with the
key derived at that path (`session.ts`, `accountsAt`) and shows the answer. Another phone's Watch-only tab scans the
pairing (or a Keystone's or OneKey's accounts), shows the balances, builds a payment, shows it, scans the answer and
broadcasts it once it is checked. The Loopback tab runs both sides on one phone.

**Testnets only.** Sepolia (chain id 11155111), Bitcoin testnet4 and Solana devnet, through public endpoints without
keys.

**Native changes need a rebuild**: `yarn prebuild`, then a native run. Face ID on the simulator: Features → Face ID →
Enrolled, then Matching Face when the prompt is up.
