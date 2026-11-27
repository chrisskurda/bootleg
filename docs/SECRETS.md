# Secrets

A secret is anything that lets someone act as you or read what is yours: a password, a server token, an API key, an OAuth refresh token, a session cookie, a client certificate or private key, a pairing key. bootleg keeps every one of them in the operating system's credential store, never with its settings, its library cache or its exports:

| Platform | Store | Where to see the items |
|---|---|---|
| macOS | Keychain (login keychain) | Keychain Access, search for `org.skurda.bootleg` |
| Windows | Credential Manager | Control Panel → Credential Manager → Windows Credentials |
| Linux | Secret Service (GNOME Keyring, KWallet, KeePassXC) | Seahorse ("Passwords and Keys") or your keyring's app |

If there is no store (the browser build, or Linux with no keyring running) secrets go in app storage on that computer, as before. *Settings → Plugins → Secrets* says which one is in use: a green **secure** badge for a system store, an amber **not encrypted** one for app storage.

## What is stored

Every item has the service name `org.skurda.bootleg` and an account name that says what it is:

- `source/<plugin>/<connection>`: the secret config of a library connection, as one JSON object. For Subsonic that is the salted token (`{"token": "…"}`); the password itself is never stored anywhere.
- `plugin/<id>/<name>`: a plugin's or extension's own secrets (a scrobbler's token, for example), written through `api.secrets` in JS or `secrets::plugin(id)` in its native code.

Today the only secret the core itself keeps is the Subsonic token. Things that only live while the app runs (the LAN media server's share links) are not stored at all.

Disconnecting a server, or deleting its library, deletes its item. Connections saved by earlier versions are moved into the store the next time bootleg starts.

## For plugin authors

**Source plugins** list their secret config fields in `secrets` (Subsonic: `secrets: ['token']`). `connect()` still returns them in `config`; the app takes them out before saving, keeps them in the store, and puts them back into the config it passes to `session(config)`. Nothing else changes.

**Every plugin and extension** (spec 1 too) gets `api.secrets`. Anything secret goes here, never in `api.settings`:
```js
await api.secrets.set('token', value)   // '' or null deletes
await api.secrets.get('token')          // → string | null
await api.secrets.delete('token')
api.secrets.secure                      // true when a system store is in use
api.secrets.where                       // "in the macOS Keychain", for your settings text
```
Values are strings: store binary data (a certificate, a key) as base64, and several fields as JSON. Names are `[A-Za-z0-9._-]`, up to 80 characters, and a plugin only ever sees its own. This keeps plugins from reading each other's secrets by mistake. It is not a sandbox: all plugins run in the app's window, which is why enabling one asks for confirmation.

**Native code** (Rust, plugin spec §5.3) uses the same items through `bootleg_plugin_api::secrets::plugin("<id>")`, with `get`, `set` and `delete`. A call can wait on a keychain prompt, so make it from a job or a worker thread. A **helper process** (spec 2.1) never reads the keychain itself; the plugin passes it what it needs.

## Implementation

- Rust: the store is `src-tauri/plugin-api/src/secrets.rs` (so native plugins share it), and `src-tauri/src/secrets.rs` exposes it to JS as `secret_status`, `secret_get`, `secret_set`, `secret_delete`. It uses `keyring-core` with `apple-native-keyring-store`, `windows-native-keyring-store` and `zbus-secret-service-keyring-store` (all MIT/Apache-2.0; the Linux one is pure Rust and needs no system library).
- JS: `src/lib/secrets.js` (the cache, the app-storage fallback, connection splitting and migration). Tested in `tests/secrets.test.mjs`.
- The desktop self-test and `BOOTLEG_SECRETS=memory` use a store in memory, so tests never touch the real keychain. `cargo test --manifest-path src-tauri/plugin-api/Cargo.toml -- --ignored` writes and deletes one item in the real store.
- **Development builds on macOS:** a Keychain item remembers which app created it. Each rebuilt, unsigned debug binary counts as a new app, so macOS may ask once whether it may use the item ("Always Allow" stops the question for that build). Signed release builds don't ask.
