# SteamTools

A mobile app for managing Steam accounts: Steam Guard codes, trade offers,
mobile confirmations, inventory management and Community Market listings.

Built with **React Native / Expo** (JavaScript).

---

## Why React Native and not a web app

Steam sends no CORS headers, so a page running in a browser cannot call
`steamcommunity.com` or `api.steampowered.com` at all. React Native's `fetch` is
backed by the platform's native HTTP stack, which has no CORS layer, so the app
talks to Steam directly with no proxy or server in between.

---

## Features

### Steam Guard
- Generates 2FA codes for every stored account, with a live countdown.
- Corrects for clock drift against Steam's own clock, so codes stay valid even
  when the phone's time is off.
- Tap a code to copy it.

### Trade offers
- Incoming and outgoing offers with the items on both sides.
- Accept, decline and cancel.
- Gift offers (where you give up nothing) are marked as such.

### Mobile confirmations
- Lists everything Steam is waiting on: trades, market listings, account changes.
- Approve or cancel individually, or all at once.
- Bulk approval warns when account-level changes are in the batch.

### Inventory
- Grid overview per game (CS2, Dota 2, TF2, Rust, Steam cards, and more).
- Search and a tradable-only filter.
- **Multi-select** with select-all, invert and clear.
- From the selection:
  - **Send to a trade offer URL** — the partner SteamID is parsed from the URL
    and shown before sending, and the resulting confirmation can be approved
    automatically.
  - **List on the Community Market** — prices can be filled in from the current
    market lowest with a configurable undercut, showing what you receive after
    fees per item and in total.

### Automation
Per account, with its own polling interval:
- Auto-confirm trade confirmations.
- Auto-confirm market listing confirmations.
- Auto-accept gift offers (only offers where you give up nothing).
- Auto-accept from a list of trusted SteamID64s.
- Optionally decline everything else.
- Local notifications when it acts, and an activity log.

Automation runs while the app is open. It polls accounts sequentially with an
error backoff, because Steam rate-limits aggressively.

### maFiles (import / export)
- Imports plain `.maFile` files from SteamDesktopAuthenticator.
- Imports SDA's **encrypted** maFiles when their `manifest.json` is selected in
  the same go (the salt and IV live there).
- Imports and exports encrypted SteamTools backups covering all accounts.
- **The Steam account password is stored in the maFile when one is present**, so
  a backup restores an account that can sign itself back in. Including passwords
  is a toggle at export time.
- Single-account export stays SDA-compatible.

---

## Security

| | |
|---|---|
| At rest | AES-256-CBC, key from PBKDF2-SHA256 (100k iterations) over your master password |
| Integrity | Encrypt-then-MAC with HMAC-SHA256, so a wrong password or an altered file is reported instead of yielding garbage |
| Exports | Same construction, 150k iterations, iteration count stored in the file so it can be raised later |
| Master password | Never stored, unless you opt into "remember on this device", which puts it in the iOS Keychain / Android Keystore behind your screen lock |
| Auto-lock | Configurable; locks after the app has been in the background long enough |
| Randomness | Platform CSPRNG only — the code throws rather than falling back to `Math.random` |

Secrets are only ever sent to Steam itself. There is no backend.

Auto-confirmation is deliberately limited to trade and market-listing
confirmations. Phone number changes, account recovery and API key registrations
are never approved automatically, since those are what account-takeover attempts
look like.

### Accounts are isolated from each other

React Native's `fetch` shares one process-wide native cookie jar, so signing in a
second account would otherwise clobber the first. Every request instead uses
`credentials: 'omit'` with a `Cookie` header built from that account's own
tokens, which keeps sessions separate and makes multi-account polling safe.

---

## Getting started

```bash
npm install
npm start          # then scan the QR code with Expo Go
npm run android    # or run on a connected device / emulator
npm run ios
```

First launch asks you to choose a master password, which encrypts everything on
the device. There is no recovery for it.

Then either import maFiles (Accounts → Add → Choose files) or add an account by
hand with its `shared_secret` and `identity_secret`.

### Signing in

- `shared_secret` alone is enough to generate Guard codes.
- `identity_secret` is additionally needed for confirmations.
- Storing the account password lets the app sign in and renew sessions on its
  own, which is what makes unattended automation work.

Login uses Steam's current `IAuthenticationService` flow: the password is
RSA-encrypted with Steam's public key, and the Guard code is generated and
submitted automatically when a `shared_secret` is stored. Sessions renew from the
long-lived refresh token.

---

## Development

```bash
npm test                              # 77 tests
npx eslint src App.js index.js
npx expo export --platform android    # verify the bundle builds
```

The suite runs against a mocked `fetch`, so it exercises real request
construction and response parsing without touching Steam:

- Crypto verified against Node's OpenSSL bindings, including decrypting the RSA
  output with a real private key.
- Guard codes checked against an independently transcribed reference across 500
  time slots.
- Login asserts the password reaches Steam RSA-encrypted and never in the clear.
- Automation asserts it never gives items away unprompted and never
  auto-approves phone-number, account-recovery or API-key confirmations.

### Layout

```
src/lib/       bytes, crypto (SHA/HMAC/PBKDF2/AES), RSA, randomness, sharing
src/steam/     guard, http, session, confirmations, trades, inventory, market, maFile
src/storage/   encrypted vault
src/state/     app context, automation engine
src/ui/        theme and shared components
src/screens/   the screens
```

---

## Notes and limits

- **Automation only runs with the app open.** Mobile platforms do not allow
  indefinite background polling; iOS in particular will not keep a timer alive.
- **Market fees are an estimate.** The publisher's cut differs per game, so what
  you actually receive can differ by a cent or two.
- Steam rate-limits hard. Intervals below 30 seconds are not accepted, and price
  lookups are paced deliberately.
- A trade offer URL without a token cannot be used; Steam requires it.
- This is an unofficial tool and is not affiliated with or endorsed by Valve.
