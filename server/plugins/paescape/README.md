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

## Applying the world's configuration

The website is authoritative for a hosted world's settings, and the platform
returns them from every configuration-bearing call - the world session
(`POST /api/world/auth`), the hosted handshake, and lease renewal/heartbeat. The
blob is in the website's shape (`{ settings: { spawn, xpRate, zones, ... } }`),
which differs from the flat `world.json` the runtime reads.

`plugins/paescape/PlatformWorldConfig.js` translates that blob into the runtime's
world.json shape and the plugin layers it over the running world through
`WorldDefinition.applyWorldConfigOverlay` (a core entry point; it never writes to
disk). This makes an owner's configured spawn/respawn, XP rate, description,
gameframe, zone tags and members/F2P flag take effect on the host. The overlay is
re-applied whenever the platform's `configRevision` changes.

Fail-closed: an overlay that fails world validation (a bad spawn, a free-to-play
spawn outside every f2p zone, reversed zone bounds) is refused with a warning, and
the running world keeps its packaged configuration. Plugin *enablement* and
per-plugin `pluginConfig` are resolved once at startup, so they remain a
restart-to-apply change, exactly as editing `world.json` is.

## Configuration

Via `world.json` `pluginConfig` (preferred) or environment variables:

| Key | Env | Meaning |
| --- | --- | --- |
| `PaeScape:platformUrl` | `PAESCAPE_PLATFORM_URL` | Platform base, e.g. `https://paescape.online` (the public `/platform` path is added automatically) |
| `PaeScape:worldId` | `PAESCAPE_WORLD_ID` | World id issued by the website |
| `PaeScape:worldSecret` | `PAESCAPE_WORLD_SECRET` | World credential (issued once) |
| `PaeScape:publicEndpoint` | `PAESCAPE_PUBLIC_ENDPOINT` | Public HTTPS origin players reach |

The credential is shown once in the website's world page and stored hashed on
the platform. It is scoped to this world only and can be revoked.

### Public endpoint registration (Task 30)

When `PAESCAPE_PUBLIC_ENDPOINT` is set to an `https://` origin and this server
holds a lease, it reports that address to the platform (`POST /api/server/endpoint`)
once per launch. The platform binds it to the world the lease authorises, verifies
it (it must be reachable and, when it answers, must advertise this world), and only
then will it send players here. Reporting is best-effort and never fatal: an owner
can also register and verify the address on the world page, and a server-reported
address never overwrites an owner-set one.

The endpoint must expose `GET /api/platform/health`, which answers with this
world's identity (`{ ok, service, worldId, generation, version, leased }`) and no
secret, so the platform can prove a registered address is this world. Core routes
`/api/platform/*` to `PluginManager.handlePlatformControl`, so this route is owned
by the plugin and needs no extra framework wiring.

### Platform base URL

The website serves the platform behind a public path prefix (`/platform`); the
production reverse proxy routes `/platform/*` to the platform service and `/api/*`
to the cache service. `PAESCAPE_PLATFORM_URL` accepts any of:

- a bare origin (`https://paescape.online`) - the `/platform` path is added;
- an origin that already carries the path (`https://paescape.online/platform`) -
  used as-is, never double-prefixed;
- an explicit development or alternative base (`http://127.0.0.1:5176/backend`) -
  preserved as configured.

`plugins/paescape/PlatformUrl.js` performs this normalisation once, centrally, so
enrollment, handshake, lease renewal, content, public-key retrieval and player
persistence all append to the same base. `PAESCAPE_PLATFORM_PUBLIC_PATH` (or the
platform's own `PLATFORM_PUBLIC_PATH`) overrides the default `/platform`.

## Core changes this relies on

- `net/NetworkBuilder.ts` - routes `/api/platform/*` to
  `PluginManager.handlePlatformControl`, and runs
  `PluginLoginExtension.preAuthenticate` after the name/ban/revision checks and
  before the password check.
- `plugins/PluginTypes.ts` - `PluginLoginVouch`, `preAuthenticate`, and
  `registerPlatformControlHandler`.
- `plugins/PluginManager.ts` - `handlePlatformControl` dispatch.
- `game/definition/WorldDefinition.ts` - `applyWorldConfigOverlay`, a generic
  runtime overlay of a world configuration over the file's, exposed to plugins as
  `core.WorldDefinition`. It re-syncs the spawn, zones, members and gameframe
  accessors and is fail-closed: an overlay that fails validation is refused.

These are additive: with no PaeScape plugin enabled, `preAuthenticate` is absent
and no control handler is registered, so the login path and HTTP server behave
exactly as before.
