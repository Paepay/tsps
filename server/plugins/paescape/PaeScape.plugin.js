"use strict";

/**
 * PaeScape Realms world-server integration.
 *
 * Connects a self-hosted world to the central platform (PaeScape_Realms/platform):
 *
 *   - startup handshake   POST /api/world/auth          -> short-lived world session
 *   - heartbeat           POST /api/world/heartbeat      -> online status, player count
 *   - ticket login        POST /api/world/tickets/redeem -> passwordless character login
 *   - link challenge      POST /api/world/link           -> ::link <code>
 *   - control API         /api/platform/*                -> create/summary/delete for the website
 *
 * Two connection modes:
 *
 *   hosted (default for a distributed server.exe) - the installation enrolls itself with
 *     the platform (a short code shown in the console, claimed on the website), receives a
 *     scoped credential, then performs the layered startup handshakes: a signed
 *     challenge-response handshake (nonce + installation credential + release generation),
 *     an authoritative world-configuration fetch, and an authorised content manifest fetch.
 *     A short-lived lease authorises config/content/persistence calls and is renewed on a
 *     timer; when the platform publishes a newer release the renewal is refused and the
 *     server performs its graceful shutdown so the launcher can update and restart it.
 *
 *   configured (legacy / local) - PAESCAPE_WORLD_SECRET is set, so the plugin exchanges the
 *     world credential for a world session directly (no enrollment needed).
 *
 * Configuration (world.json pluginConfig or the server environment):
 *   PAESCAPE_PLATFORM_URL      e.g. https://paescape.online  (required for online mode)
 *   PAESCAPE_WORLD_ID          the world id issued by the website
 *   PAESCAPE_WORLD_SECRET      the world credential (issued once, store it safely)
 *   PAESCAPE_PUBLIC_ENDPOINT   https://host[:port] players reach this world's web client at
 *
 * The plugin never receives Discord tokens. It only ever sees a single-use login ticket, which it
 * redeems with the platform, and the platform's Ed25519-signed control token, which it verifies
 * with the platform's public key. All gameplay stays on this machine.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
const { Accounts } = require("../../src/main/typescript/elvarg/game/entity/impl/player/Accounts");
const { MAIN_PROFILE, LEAGUE_PROFILE } = require("../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerProfile");
const { SkillManager } = require("../../src/main/typescript/elvarg/game/content/skill/SkillManager");

/** The control-token path prefix the core routes to this plugin. */
const CONTROL_PREFIX = "/api/platform/";
/** How often the heartbeat reports to the platform. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Refresh the short-lived world session this long before it expires. */
const SESSION_REFRESH_MARGIN_MS = 60_000;
/** A login "password" matching this shape is treated as a platform ticket and redeemed. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

let api;
let platform = { url: "", worldId: "", worldSecret: "", endpoint: "" };
let publicKey = null;
let session = null; // { token, expiresAt }
let heartbeatTimer = null;
let sessionTimer = null;
let userAccountPath = "";
/** platform userId -> the game account key (primary character name) it owns on this world. */
let userAccounts = {};

/**
 * Hosted-mode state. A distributed server.exe has no world secret, so it enrolls
 * itself: it keeps an installation identity on disk, shows an enrollment code, and
 * once claimed it holds a scoped credential. The lease authorises config, content
 * and persistence calls; it is renewed on a timer and stops renewing the moment
 * the platform publishes a newer release.
 */
let installation = null; // { key, credential }
let lease = null; // { token, expiresAt, generation, configRevision, contentRevision }
let leaseTimer = null;
let enrollmentTimer = null;
let worldConfig = null; // the authoritative config the platform returned
let worldConfigRevision = 0;
let outdated = false;
/** Path of the installation identity (hosted mode only). */
const INSTALLATION_FILE = "paescape-installation.json";

function log(message) {
  console.log(`[paescape] ${message}`);
}

function warn(message) {
  console.warn(`[paescape] ${message}`);
}

/* --------------------------------------------------------------- config --- */

/* ---------------------------------------------------- build metadata --- */

/**
 * The release generation and protocol the packaging pipeline embedded at build
 * time. A distributed server.exe ships these; in a source checkout they default
 * to generation 0 / protocol 1, which the platform refuses as outdated unless a
 * release with that generation is current (so a dev build is always "outdated").
 * The value is not a secret and is not trusted by the platform: the platform
 * decides what is current from its own release record.
 */
function readBuildMetadata() {
  const fromEnv = (key, fallback) => {
    const value = process.env[key];
    return value === undefined || value === "" ? fallback : value;
  };
  return {
    generation: Number(fromEnv("PAESCAPE_RELEASE_GENERATION", "0")) || 0,
    version: String(fromEnv("PAESCAPE_BUILD_VERSION", "dev")),
    protocolVersion: Number(fromEnv("PAESCAPE_PROTOCOL_VERSION", "1")) || 1,
  };
}

/* -------------------------------------------- hosted-mode identity ----- */

/** Load or create the installation identity, stored beside the executable. */
function loadInstallation() {
  const file = path.join(process.cwd(), "data", INSTALLATION_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.key === "string" && parsed.key.length >= 16) {
      return { key: parsed.key, credential: typeof parsed.credential === "string" ? parsed.credential : null };
    }
  } catch {
    /* no identity yet */
  }
  const created = { key: `wsk_${crypto.randomBytes(24).toString("base64url")}`, credential: null };
  persistInstallation(created);
  return created;
}

function persistInstallation(value) {
  try {
    const file = path.join(process.cwd(), "data", INSTALLATION_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key: value.key, credential: value.credential ?? null }, null, 2), { mode: 0o600 });
  } catch (error) {
    warn(`could not persist the installation identity: ${error.message}`);
  }
}

function readConfig() {
  const fromPlugin = (key, fallback) => {
    try {
      return api.getPluginConfig(`PaeScape:${key}`, fallback);
    } catch {
      return fallback;
    }
  };
  const url = String(process.env.PAESCAPE_PLATFORM_URL ?? fromPlugin("platformUrl", "")).trim().replace(/\/+$/, "");
  return {
    url,
    worldId: String(process.env.PAESCAPE_WORLD_ID ?? fromPlugin("worldId", "")).trim(),
    worldSecret: String(process.env.PAESCAPE_WORLD_SECRET ?? fromPlugin("worldSecret", "")).trim(),
    endpoint: String(process.env.PAESCAPE_PUBLIC_ENDPOINT ?? fromPlugin("publicEndpoint", "")).trim(),
  };
}

function loadUserAccounts() {
  try {
    userAccounts = JSON.parse(fs.readFileSync(userAccountPath, "utf8")) || {};
  } catch {
    userAccounts = {};
  }
}

function saveUserAccounts() {
  try {
    fs.mkdirSync(path.dirname(userAccountPath), { recursive: true });
    fs.writeFileSync(userAccountPath, JSON.stringify(userAccounts, null, 2));
  } catch (error) {
    warn(`could not persist the account map: ${error.message}`);
  }
}

/* ------------------------------------------------------------- platform --- */

/**
 * The bearer token and base path for platform calls that a running world makes.
 * In hosted mode these are lease-authorised under /api/server/*; in configured
 * mode they are session-authorised under /api/world/*.
 */
async function worldEndpoint(path) {
  if (lease) return { token: lease.token, path: `/api/server${path}` };
  return { token: await ensureSession(), path: `/api/world${path}` };
}

/** A signed request to the platform. Sends the bearer token when given. */
async function platformFetch(pathname, { method = "GET", token, body, signal } = {}) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${platform.url}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
}

/** Exchange the world credential for a short-lived world session. */
async function authenticate() {
  const result = await platformFetch("/api/world/auth", {
    method: "POST",
    body: { secret: platform.worldSecret },
  });
  if (!result.ok || !result.json?.token) {
    throw new Error(result.json?.error ?? `platform refused the world credential (${result.status})`);
  }
  session = {
    token: result.json.token,
    expiresAt: Date.parse(result.json.expiresAt) || Date.now() + 900_000,
  };
  log(`authenticated with the platform as world ${result.json.world?.id ?? platform.worldId}`);
  scheduleSessionRefresh();
}

function scheduleSessionRefresh() {
  if (sessionTimer) clearTimeout(sessionTimer);
  const delay = Math.max(5_000, (session?.expiresAt ?? Date.now()) - Date.now() - SESSION_REFRESH_MARGIN_MS);
  sessionTimer = setTimeout(() => {
    authenticate().catch((error) => warn(`session refresh failed: ${error.message}`));
  }, delay);
  sessionTimer.unref?.();
}

async function ensureSession() {
  if (!session || session.expiresAt - Date.now() < SESSION_REFRESH_MARGIN_MS) await authenticate();
  return session.token;
}

/** Report build, config revision and player count; refresh the session if it expired. */
async function heartbeat() {
  try {
    const token = await ensureSession();
    const result = await platformFetch("/api/world/heartbeat", {
      method: "POST",
      token,
      body: {
        buildVersion: BUILD.version,
        configRevision: worldConfigRevision || Number(process.env.PAESCAPE_CONFIG_REVISION ?? 1),
        playerCount: api.core.World.getNetworkPlayerCount ? api.core.World.getNetworkPlayerCount() : 0,
        maxPlayers: api.core.World.getPlayers?.().capacity?.() ?? 0,
        endpointUrl: platform.endpoint || undefined,
      },
    });
    if (result.status === 401) session = null; // refresh on the next beat
  } catch (error) {
    warn(`heartbeat failed: ${error.message}`);
  }
}

/** Fetch and cache the platform's Ed25519 public key (base64 DER, SPKI). */
async function fetchPublicKey() {
  const result = await platformFetch("/api/platform/public-key");
  if (result.ok && result.json?.publicKey) {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(result.json.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    log("cached the platform control public key");
    return true;
  }
  warn("could not read the platform public key; control requests will be refused");
  return false;
}

/**
 * Verify a platform control token: `${base64url(payload)}.${base64(signature)}`. The payload is an
 * Ed25519-signed JSON claim set; the token is short lived and scoped to one action and one world.
 */
function verifyControlToken(header, action) {
  if (!publicKey || typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature) return null;
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.worldId !== platform.worldId) return null;
  if (Number(claims.exp) * 1000 <= Date.now()) return null;
  if (action && claims.action !== action) return null;
  return claims;
}

/* ------------------------------------------------------- character data --- */

function isRealItem(item) {
  return Boolean(item) && Number(item.getId?.() ?? -1) > 0;
}

/** The authoritative summary the website shows, read from a character's save. */
function buildSummary(name) {
  const save = GameConstants.PLAYER_PERSISTENCE.load(name, MAIN_PROFILE);
  const empty = () => ({ name, combatLevel: 3, totalLevel: 0, skills: { level: [], base: [], experience: [] }, equipment: [], inventory: [], fetchedAt: new Date().toISOString() });
  if (!save) return empty();
  const skills = save.getSkills?.();
  const levels = (skills?.level ?? []).map((value) => Number(value) || 0);
  const base = (skills?.maxLevel ?? []).map((value) => Number(value) || 0);
  const experience = (skills?.experience ?? []).map((value) => Math.round(Number(value) || 0));
  let totalLevel = 0;
  for (let i = 0; i < SkillManager.AMOUNT_OF_SKILLS; i++) totalLevel += base[i] || 0;
  const toSlot = (item, slot) => (isRealItem(item) ? { slot, itemId: item.getId(), amount: Number(item.getAmount()) || 1 } : null);
  return {
    name: String(save.getDisplayName?.() ?? name),
    combatLevel: SkillManager.calculateCombatLevel(base),
    totalLevel,
    skills: { level: levels, base, experience },
    equipment: (save.getEquipment?.() ?? []).map(toSlot).filter(Boolean),
    inventory: (save.getInventory?.() ?? []).map(toSlot).filter(Boolean),
    appearance: save.getAppearance?.() ?? undefined,
    lastPlayedAt: null,
    fetchedAt: new Date().toISOString(),
  };
}

/** A valid, unused character name on this world. */
function validateName(name) {
  const trimmed = String(name ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > 12) return "Character names must be 1-12 characters.";
  if (!api.core.Misc.isValidName(trimmed)) return "Character names may only use letters, numbers and spaces.";
  if (Accounts.accountOf(trimmed)) return "That name is already taken on this world.";
  if (Accounts.isDeleted(trimmed)) return "That name belonged to a deleted character and can't be used again.";
  return null;
}

/** Ensure the character exists on this world, attached to the account the platform user owns. */
function createCharacterForUser(userId, name) {
  const existingOwner = Accounts.accountOf(name);
  if (existingOwner) throw new Error("That character name is already taken on this world.");

  let accountKey = userId ? userAccounts[userId] : undefined;
  let account = accountKey ? Accounts.entryOf(accountKey) : undefined;
  if (!account) {
    // First character for this platform user, or an unknown user: this name becomes its primary.
    accountKey = Accounts.key(name);
    Accounts.ensure(name);
    account = Accounts.entryOf(accountKey);
    if (userId) {
      userAccounts[userId] = accountKey;
      saveUserAccounts();
    }
  } else {
    if (Accounts.charactersOf(accountKey).length >= 3) {
      throw new Error("That account already has three characters on this world.");
    }
    Accounts.addCharacter(accountKey, api.core.Misc.formatDisplayName(name));
  }
  const key = Accounts.key(name);
  const display = (Accounts.charactersOf(accountKey).find((c) => Accounts.key(c.name) === key)?.name) ?? name;
  return { accountKey, name: display };
}

/* ------------------------------------------------------- control handler --- */

async function handleControl(request) {
  const pathname = request.path.split("?")[0];
  if (!pathname.startsWith(CONTROL_PREFIX)) return null;
  const action = verifyAction(pathname, request.method);
  const claims = verifyControlToken(request.headers.authorization, action);
  if (!claims) {
    return { status: 401, body: { ok: false, error: "This world could not verify the platform's control token." } };
  }
  const segments = pathname.slice(CONTROL_PREFIX.length).split("/").filter(Boolean);
  let body = {};
  if (request.body) {
    try {
      body = JSON.parse(request.body);
    } catch {
      return { status: 400, body: { ok: false, error: "Malformed request body." } };
    }
  }

  // POST /api/platform/characters  -> create
  if (request.method === "POST" && segments.length === 1 && segments[0] === "characters") {
    const problem = validateName(body.name);
    if (problem) return { status: 400, body: { ok: false, error: problem } };
    try {
      const created = createCharacterForUser(String(body.userId ?? ""), String(body.name).trim());
      return { status: 201, body: { ok: true, character: buildSummary(created.name) } };
    } catch (error) {
      return { status: 409, body: { ok: false, error: error.message } };
    }
  }

  // GET /api/platform/characters/:name/summary  -> authoritative summary
  if (request.method === "GET" && segments.length === 3 && segments[0] === "characters" && segments[2] === "summary") {
    const name = decodeURIComponent(segments[1]);
    const account = Accounts.accountOf(name);
    if (!account) return { status: 404, body: { ok: false, error: "That character is not registered on this world." } };
    return { status: 200, body: { ok: true, character: buildSummary(name) } };
  }

  // POST /api/platform/characters/:name  -> delete the save and the association
  if (request.method === "POST" && segments.length === 2 && segments[0] === "characters") {
    const name = decodeURIComponent(segments[1]);
    const accountKey = Accounts.accountOf(name);
    if (!accountKey) return { status: 404, body: { ok: false, error: "That character is not registered on this world." } };
    if (String(body.confirmName ?? "") !== name) {
      return { status: 400, body: { ok: false, error: "The confirmation name does not match." } };
    }
    if (Accounts.isPrimary(accountKey, name)) {
      return { status: 409, body: { ok: false, error: "Your first character on this world can't be deleted." } };
    }
    try {
      await GameConstants.PLAYER_PERSISTENCE.delete(name, MAIN_PROFILE);
      await GameConstants.PLAYER_PERSISTENCE.delete(name, LEAGUE_PROFILE).catch(() => {});
      Accounts.removeCharacter(accountKey, name);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      return { status: 500, body: { ok: false, error: `The character could not be deleted: ${error.message}` } };
    }
  }

  return { status: 404, body: { ok: false, error: "No such control route." } };
}

/** Map a control path to the action name the platform signs the token with. */
function verifyAction(pathname, method) {
  if (pathname === `${CONTROL_PREFIX}characters` && method === "POST") return "character:create";
  if (pathname.endsWith("/summary")) return "character:summary";
  if (method === "POST" && pathname.startsWith(`${CONTROL_PREFIX}characters/`)) return "character:delete";
  return "";
}

/* --------------------------------------------------------- login ticket --- */

async function preAuthenticate({ typedName, password }) {
  if (!TICKET_PATTERN.test(password)) return undefined;
  let redeemed;
  try {
    const { token, path: ticketPath } = await worldEndpoint("/tickets/redeem");
    if (!token) return undefined;
    redeemed = await platformFetch(ticketPath, { method: "POST", token, body: { ticket: password } });
  } catch (error) {
    warn(`ticket redemption failed: ${error.message}`);
    return undefined;
  }
  if (!redeemed.ok || !redeemed.json?.character) return undefined; // not a ticket: fall back to a password

  const characterName = String(redeemed.json.character.name);
  const accountKey = Accounts.accountOf(characterName) ?? Accounts.key(characterName);
  if (!Accounts.entryOf(accountKey)) {
    try {
      Accounts.ensure(characterName);
    } catch {
      return undefined;
    }
  }
  const save = GameConstants.PLAYER_PERSISTENCE.load(characterName, MAIN_PROFILE) ?? null;
  log(`ticket login for ${characterName}`);
  return { username: characterName, credentialName: characterName, save, passwordHash: String(save?.getPasswordHashWithSalt?.() ?? "") };
}

/* ------------------------------------------------------------ ::link ------ */

async function linkCommand(event) {
  const raw = String(event.raw ?? "");
  const code = raw.replace(/^\S+\s*/, "").trim();
  const player = event.player;
  if (!code) {
    player.sendMessage("Usage: ::link <code>");
    return true;
  }
  try {
    const { token, path: linkPath } = await worldEndpoint("/link");
    const result = await platformFetch(linkPath, {
      method: "POST",
      token,
      body: { code, characterName: player.getUsername() },
    });
    if (result.ok) player.sendMessage("Your character is now linked to your PaeScape account.");
    else player.sendMessage(`Link failed: ${result.json?.error ?? "unknown error"}`);
  } catch (error) {
    player.sendMessage(`Link failed: ${error.message}`);
  }
  return true;
}

/* ------------------------------------------------- hosted lifecycle --- */

/**
 * Hosted mode: no world secret is configured, so the installation enrolls itself.
 * Step 1 shows a code; the host claims it on the website; step 2 polls until it
 * is claimed and receives a scoped credential (stored on disk).
 */
async function beginEnrollment() {
  const begin = await platformFetch("/api/server/enroll/begin", {
    method: "POST",
    body: { installationKey: installation.key, label: "server.exe" },
  });
  if (begin.status === 409) {
    // Already enrolled on a previous run: recover the credential from disk.
    if (installation.credential) return installation;
    warn("this installation is already enrolled but the credential is missing; revoke it in the website and start again");
    return null;
  }
  if (!begin.ok || !begin.json?.code) {
    warn(`enrollment could not start: ${begin.json?.error ?? begin.status}`);
    return null;
  }
  log("");
  log("=========================================================");
  log("  This server is not set up for a world yet.");
  log("  1. Sign in at the PaeScape website with Discord.");
  log("  2. Open the world you want to run and choose 'Enroll a server'.");
  log(`  3. Enter this code:  ${begin.json.code}`);
  log(`     (it expires ${new Date(begin.json.expiresAt).toLocaleTimeString()}, or restart for a new one)`);
  log("=========================================================");
  log("");
  // Poll until the host claims the code.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && !outdated) {
    await sleep(5000);
    const complete = await platformFetch("/api/server/enroll/complete", {
      method: "POST",
      body: { installationKey: installation.key },
    });
    if (complete.ok && complete.json?.credential) {
      installation.credential = String(complete.json.credential);
      persistInstallation(installation);
      log(`enrolled with world ${complete.json.worldId}`);
      return installation;
    }
  }
  return null;
}

/**
 * Challenge-response handshake. The platform issues a single-use nonce; the
 * server presents its installation credential, that nonce and the release
 * generation it is running. The platform refuses any generation that is not
 * current, so an outdated server is rejected here rather than by the launcher.
 */
async function handshake() {
  const nonce = await platformFetch("/api/server/handshake/nonce", {
    method: "POST",
    body: { installationKey: installation.key },
  });
  if (!nonce.ok || !nonce.json?.nonce) {
    warn(`handshake nonce refused: ${nonce.json?.error ?? nonce.status}`);
    return null;
  }
  const result = await platformFetch("/api/server/handshake", {
    method: "POST",
    token: installation.credential,
    body: { nonce: nonce.json.nonce, generation: BUILD.generation, protocolVersion: BUILD.protocolVersion },
  });
  if (result.status === 409) {
    // The platform published a newer release while we were starting.
    markOutdated(result.json?.error ?? "This server is outdated.");
    return null;
  }
  if (!result.ok || !result.json?.lease?.token) {
    warn(`handshake refused: ${result.json?.error ?? result.status}`);
    return null;
  }
  lease = {
    token: result.json.lease.token,
    expiresAt: Date.parse(result.json.lease.expiresAt) || Date.now() + 600_000,
    generation: Number(result.json.lease.generation ?? BUILD.generation),
    configRevision: Number(result.json.world?.configRevision ?? 0),
    contentRevision: String(result.json.contentRevision ?? ""),
  };
  applyWorldConfig(result.json.world?.config, Number(result.json.world?.configRevision ?? 0));
  log(`authorised for release generation ${lease.generation} (config revision ${lease.configRevision})`);
  scheduleLeaseRenewal();
  return result.json;
}

/** Renew the short-lived lease; refused the moment the platform has a newer release. */
async function renewLease() {
  if (!lease) return;
  try {
    const result = await platformFetch("/api/server/lease/renew", {
      method: "POST",
      token: lease.token,
      body: {
        generation: lease.generation,
        configRevision: lease.configRevision,
        contentRevision: lease.contentRevision,
        playerCount: playerCount(),
        maxPlayers: api.core.World.getPlayers?.().capacity?.() ?? 0,
        buildVersion: BUILD.version,
        endpointUrl: platform.endpoint || undefined,
      },
    });
    if (result.status === 409) {
      markOutdated(result.json?.error ?? "This server is outdated.");
      return;
    }
    if (result.status === 401) {
      lease = null;
      await handshake();
      return;
    }
    if (!result.ok) {
      warn(`lease renewal refused: ${result.json?.error ?? result.status}`);
      return;
    }
    lease.expiresAt = Date.parse(result.json.expiresAt) || Date.now() + 600_000;
    lease.generation = Number(result.json.generation ?? lease.generation);
    if (Number(result.json.configRevision ?? 0) !== lease.configRevision) {
      applyWorldConfig(result.json.config, Number(result.json.configRevision ?? 0));
    }
    scheduleLeaseRenewal();
  } catch (error) {
    warn(`lease renewal failed: ${error.message}`);
  }
}

function scheduleLeaseRenewal() {
  if (leaseTimer) clearTimeout(leaseTimer);
  const delay = Math.max(15_000, (lease?.expiresAt ?? Date.now()) - Date.now() - 60_000);
  leaseTimer = setTimeout(() => void renewLease(), delay);
  leaseTimer.unref?.();
}

/**
 * Load the platform's authoritative world configuration into memory. The host
 * cannot override paid features, XP rates or player caps by editing local files:
 * the values here come from the platform and replace what the world would
 * otherwise read from its own definition.
 */
function applyWorldConfig(config, revision) {
  if (!config || typeof config !== "object") return;
  worldConfig = config;
  worldConfigRevision = Number(revision) || 0;
  const settings = (config.settings && typeof config.settings === "object" ? config.settings : {}) || {};
  if (typeof settings.experienceMultiplier === "number") {
    try {
      api.core.GameConstants.EXPERIENCE_MULTIPLIER = settings.experienceMultiplier;
      log(`applying platform XP multiplier ${settings.experienceMultiplier}`);
    } catch { /* GameConstants is frozen on some builds; the heartbeat still reports the revision */ }
  }
  log(`loaded platform world configuration revision ${worldConfigRevision}`);
}

/** Fetch the custom-content manifest the platform authorises for this world. */
async function fetchContentManifest() {
  if (!lease) return null;
  const result = await platformFetch("/api/server/content-manifest", { token: lease.token });
  if (!result.ok) return null;
  const entries = Array.isArray(result.json?.entries) ? result.json.entries : [];
  log(`authorised custom content: ${entries.length} asset(s) (revision ${result.json?.revision ?? "-"})`);
  return result.json;
}

function playerCount() {
  return api.core.World.getNetworkPlayerCount ? api.core.World.getNetworkPlayerCount() : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The platform published a newer release. Stop renewing, warn players, save them
 * and shut down so the launcher can install the update and restart us. This is
 * deliberately guarded so a stuck or repeated signal cannot spin.
 */
function markOutdated(message) {
  if (outdated) return;
  outdated = true;
  warn(`OUTDATED: ${message}`);
  if (leaseTimer) clearTimeout(leaseTimer);
  if (lease) lease = null;
  try {
    api.core.World.sendMessage("The server is updating to a new version and will restart shortly. Please log out safely.");
  } catch { /* world not ready */ }
  setTimeout(() => {
    log("shutting down for an update; the launcher will restart the server");
    try {
      api.core.Server.shutdown("paescape-update");
    } catch (error) {
      warn(`graceful shutdown failed, exiting: ${error.message}`);
      process.exit(0);
    }
  }, 5_000).unref?.();
}

/* ------------------------------------------------------------- lifecycle --- */

function start() {
  platform = readConfig();
  if (!platform.url) {
    log("no PAESCAPE_PLATFORM_URL; running standalone");
    return;
  }
  userAccountPath = path.join(process.cwd(), "data", "paescape-users.json");
  loadUserAccounts();
  api.registerPlatformControlHandler(handleControl);

  if (platform.worldSecret) {
    // Configured mode: a legacy/manual deployment with a world credential.
    startConfigured();
  } else {
    // Hosted mode: a distributed server.exe with no local configuration file.
    void startHosted();
  }
  log("world control API and ticket login are active");
}

/** Legacy/manual mode: exchange a world credential for a session and heartbeat. */
function startConfigured() {
  authenticate()
    .then(() => fetchPublicKey())
    .then(() => heartbeat())
    .catch((error) => warn(`startup handshake failed: ${error.message}`));
  heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

/**
 * Hosted mode: enroll if needed, run the layered startup handshakes, then renew
 * the lease on a timer. Everything runs asynchronously so the game loop is never
 * blocked; until the handshakes finish the world has no platform lease and the
 * website will not issue player tickets for it.
 */
async function startHosted() {
  installation = loadInstallation();
  try {
    await fetchPublicKey();
    if (!installation.credential) {
      await beginEnrollment();
    }
    if (installation.credential) {
      const result = await handshake();
      if (result) await fetchContentManifest();
    }
    if (!installation.credential || !lease) {
      // Retry until the host claims the code (or the world is outdated).
      enrollmentTimer = setInterval(() => {
        if (lease || outdated) return;
        void beginEnrollment().then((enrolled) => {
          if (enrolled?.credential) return handshake().then(() => fetchContentManifest());
          return undefined;
        });
      }, 60_000);
      enrollmentTimer.unref?.();
    }
  } catch (error) {
    warn(`hosted startup failed: ${error.message}`);
  }
}
module.exports = {
  name: "PaeScape",
  enabled: false,
  register(pluginApi) {
    api = pluginApi;
    pluginApi.registerLoginExtension(() => ({ preAuthenticate }));
    pluginApi.registerCommand("link", linkCommand, pluginApi.core.PlayerRights.NONE, "Link this character to your PaeScape account");
    pluginApi.onServerStartup(() => start());
    pluginApi.onServerShutdown(() => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      if (leaseTimer) clearTimeout(leaseTimer);
      if (enrollmentTimer) clearInterval(enrollmentTimer);
    });
  },
};
