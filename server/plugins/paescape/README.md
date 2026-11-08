# PaeScape world-server integration

Connects this world server to the central PaeScape Realms platform
(`PaeScape_Realms/platform`). It is disabled by default (`enabled: false`) and
only meaningful for online worlds; a standalone/offline world runs without it.

## What it does

- **Startup handshake** - exchanges the world credential for a short-lived world
  session (`POST /api/world/auth`) and caches the platform's Ed25519 public key.
- **Heartbeat** - reports build, config revision and player count every 30 s
  (`POST /api/world/heartbeat`); the website marks the world offline when beats stop.
- **Ticket login** - a login whose password field is a platform ticket is redeemed
  (`POST /api/world/tickets/redeem`) and the character is entered without a
  password. Invalid tickets fall through to the normal password check, so nothing
  about ordinary logins changes.
- **`::link <code>`** - links the character you are logged in as to your website
  account (`POST /api/world/link`).
- **Control API** - serves `/api/platform/*` to the platform for character
  create, summary and delete. Each request carries a short-lived, Ed25519-signed
  control token naming this world and one action; the plugin verifies it with the
  platform public key and refuses anything else.

## Configuration

Via `world.json` `pluginConfig` (preferred) or environment variables:

| Key | Env | Meaning |
| --- | --- | --- |
| `PaeScape:platformUrl` | `PAESCAPE_PLATFORM_URL` | Platform origin, e.g. `https://paescape.online` |
| `PaeScape:worldId` | `PAESCAPE_WORLD_ID` | World id issued by the website |
| `PaeScape:worldSecret` | `PAESCAPE_WORLD_SECRET` | World credential (issued once) |
| `PaeScape:publicEndpoint` | `PAESCAPE_PUBLIC_ENDPOINT` | Public HTTPS origin players reach |

The credential is shown once in the website's world page and stored hashed on
the platform. It is scoped to this world only and can be revoked.

## Core changes this relies on

- `net/NetworkBuilder.ts` - routes `/api/platform/*` to
  `PluginManager.handlePlatformControl`, and runs
  `PluginLoginExtension.preAuthenticate` after the name/ban/revision checks and
  before the password check.
- `plugins/PluginTypes.ts` - `PluginLoginVouch`, `preAuthenticate`, and
  `registerPlatformControlHandler`.
- `plugins/PluginManager.ts` - `handlePlatformControl` dispatch.

These are additive: with no PaeScape plugin enabled, `preAuthenticate` is absent
and no control handler is registered, so the login path and HTTP server behave
exactly as before.
