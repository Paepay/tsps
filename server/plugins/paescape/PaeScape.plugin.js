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
const bridge = require("./PaeScapeBridge.js");
const PlatformUrl = require("./PlatformUrl.js");
const worldData = require("../persistence/WorldData");

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
/** username (lower-case) -> { token, characterId, expiresAt, timer } for hosted gameplay sessions. */
const characterSessions = new Map();

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
/** Override the directory holding the installation identity (defaults to data/). */
function installationPath() {
  return process.env.PAESCAPE_INSTALLATION_FILE
    ? path.resolve(process.env.PAESCAPE_INSTALLATION_FILE)
    : path.join(process.cwd(), "data", INSTALLATION_FILE);
}

function log(message) {
  console.log(`[paescape] ${message}`);
}

function warn(message) {
  console.warn(`[paescape] ${message}`);
}

/**
 * Exit with a distinct supervisor code. The launcher treats these as terminal and
 * will not restart in a loop: an auth failure (11) or config failure (12) needs the
 * host to act, unlike the update-required code (10) which the launcher acts on.
 */
function fatalExit(code, message) {
  console.error(`[paescape] FATAL: ${message}`);
  // Prefer a graceful shutdown so online players are saved; Server.shutdown takes
  // the exit code the launcher's supervisor interprets. Fall back to a direct exit
  // if the core is unavailable.
  try {
    if (api?.core?.Server?.shutdown) {
      api.core.Server.shutdown(`paescape-fatal-${code}`, code);
      return;
    }
  } catch { /* fall through to a direct exit */ }
  setTimeout(() => process.exit(code), 250).unref?.();
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
  // A packaged server.exe stamps the release generation and protocol beside its
  // extracted application (scripts/release/bundle.mjs writes paescape-app.json, and
  // server-bootstrap.cjs chdirs into that directory). Without this the handshake
  // would report generation 0 and the platform would refuse the build as outdated.
  let stamped = {};
  try {
    const candidates = [
      process.env.PAESCAPE_EXTRACTED_APP && path.join(process.env.PAESCAPE_EXTRACTED_APP, "paescape-app.json"),
      path.join(process.cwd(), "paescape-app.json"),
      path.join(__dirname, "..", "..", "paescape-app.json"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      stamped = JSON.parse(fs.readFileSync(candidate, "utf8")) || {};
      break;
    }
  } catch { /* a source checkout has no stamped metadata */ }
  const fromStamp = (key, fallback) => {
    const value = stamped[key];
    return value === undefined || value === null || value === "" ? fallback : value;
  };
  return {
    generation: Number(fromEnv("PAESCAPE_RELEASE_GENERATION", String(fromStamp("generation", "0")))) || 0,
    version: String(fromEnv("PAESCAPE_BUILD_VERSION", String(fromStamp("version", "dev")))),
    protocolVersion: Number(fromEnv("PAESCAPE_PROTOCOL_VERSION", String(fromStamp("protocolVersion", "1")))) || 1,
  };
}

/** The embedded build metadata, read once at module load. */
const BUILD = readBuildMetadata();

/* -------------------------------------------- hosted-mode identity ----- */

/** Load or create the installation identity, stored beside the executable. */
function loadInstallation() {
  const file = installationPath();
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
    const file = installationPath();
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
  // The configured value may be a bare origin (`https://paescape.online`), an origin
  // that already carries the public path (`https://paescape.online/platform`), or an
  // explicit development/custom base. Normalise it here, once, so every call below
  // (enrollment, handshake, lease renewal, content, public key, persistence) uses the
  // same prefixed base and a bare origin is never double-prefixed.
  const configured = String(process.env.PAESCAPE_PLATFORM_URL ?? fromPlugin("platformUrl", "")).trim();
  const url = PlatformUrl.normalisePlatformBase(configured);
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

/**
 * Resolve a login before the password is checked. A hosted world (a distributed
 * server.exe with a platform URL and no world secret) accepts only a website-issued
 * single-use ticket: the platform is the sole authority on who may play, the host
 * cannot vouch for a character, and a password login must never create a character
 * the platform does not own. Anything else fails closed. A configured/standalone
 * world keeps the old behaviour: try a ticket, otherwise fall back to the password.
 */
async function preAuthenticate({ typedName, password }, connection) {
  const hosted = Boolean(platform.url) && !platform.worldSecret;
  const refused = { reason: null };
  const attempt = await redeemLoginTicket(password, hosted, refused);
  if (!attempt.ok) {
    // Hosted worlds never fall back to a password: a failed ticket is a refusal.
    if (hosted && connection) connection.reject(refused.code ?? 3, refused.reason ?? "This login link has expired or is invalid. Please return to the PaeScape website.");
    return undefined;
  }

  const characterName = attempt.characterName;
  // Hosted worlds enforce the platform's ban decisions and one-session rule
  // before any authoritative state is loaded. A ban is never inferred locally.
  if (hosted) {
    const blocked = await moderationFor(characterName);
    if (blocked) {
      if (connection) connection.reject(4, blocked);
      return undefined;
    }
  }
  const accountKey = Accounts.accountOf(characterName) ?? Accounts.key(characterName);
  if (!Accounts.entryOf(accountKey)) {
    try {
      Accounts.ensure(characterName);
    } catch (error) {
      warn(`could not register the ticket character ${characterName}: ${error.message}`);
      if (hosted && connection) connection.reject(8, "The login server is busy.");
      return undefined;
    }
  }
  // The character's authoritative save comes from the platform (the hosted store).
  const save = GameConstants.PLAYER_PERSISTENCE.load(characterName, MAIN_PROFILE) ?? null;
  if (hosted) {
    try {
      const characterId = await characterIdFor(characterName);
      const issued = characterId ? await openCharacterSession(characterId, characterName) : null;
      if (issued) characterSessions.set(accountKey, issued);
    } catch (error) {
      // A duplicate live session is a refusal: the platform is authoritative.
      if (error && error.status === 409) {
        if (connection) connection.reject(5, "This character is already logged in.");
        return undefined;
      }
      warn(`could not open a gameplay session for ${characterName}: ${error.message}`);
      if (connection) connection.reject(8, "The PaeScape platform is unavailable; please try again shortly.");
      return undefined;
    }
  }
  log(`ticket login for ${characterName}`);
  return { username: characterName, credentialName: characterName, save, passwordHash: String(save?.getPasswordHashWithSalt?.() ?? "") };
}

/** The platform's character id for a name on this world, or null. */
async function characterIdFor(characterName) {
  const local = GameConstants.PLAYER_PERSISTENCE;
  if (local && typeof local.resolveCharacterId === "function") return local.resolveCharacterId(characterName);
  const result = await platformFetch(`/api/server/characters/by-name/${encodeURIComponent(characterName)}`, { token: lease.token });
  return result.ok && result.json?.character?.id ? String(result.json.character.id) : null;
}

/**
 * The platform's ban decision for a character: null when they may play, or a
 * message when login must be refused. The moderation route resolves the name on
 * this world, so a world ban is scoped to the world this lease belongs to and a
 * platform ban is reported as such.
 */
async function moderationFor(characterName) {
  if (!lease) return null;
  try {
    const result = await platformFetch(
      `/api/server/characters/none/moderation?name=${encodeURIComponent(characterName)}`,
      { token: lease.token },
    );
    if (!result.ok) return null;
    const moderation = result.json?.moderation;
    if (!moderation || moderation.action !== "ban") return null;
    return moderation.scope === "platform"
      ? "Your PaeScape account is banned. " + (moderation.reason ?? "")
      : "You are banned from this world. " + (moderation.reason ?? "");
  } catch (error) {
    warn(`moderation lookup failed for ${characterName}: ${error.message}`);
    return "The PaeScape platform is unavailable; please try again shortly.";
  }
}

/** Create a live platform session and schedule its renewal. */
async function openCharacterSession(characterId, characterName) {
  const result = await platformFetch("/api/server/character-sessions", {
    method: "POST", token: lease.token,
    body: { characterId, ttlSeconds: 900 },
  });
  if (!result.ok || !result.json?.token) {
    const error = new Error(result.json?.error ?? `session creation failed (${result.status})`);
    error.status = result.status;
    throw error;
  }
  const issued = {
    token: String(result.json.token),
    characterId,
    username: characterName,
    expiresAt: Date.parse(result.json.session?.expiresAt) || Date.now() + 900_000,
    timer: null,
  };
  scheduleCharacterSessionRenewal(issued);
  return issued;
}

function scheduleCharacterSessionRenewal(issued) {
  if (issued.timer) clearInterval(issued.timer);
  issued.timer = setInterval(async () => {
    if (!lease) return;
    const result = await platformFetch(`/api/server/character-sessions/${encodeURIComponent(issued.token)}/renew`, {
      method: "POST", token: lease.token, body: { ttlSeconds: 900 },
    });
    if (result.ok) {
      issued.expiresAt = Date.parse(result.json.expiresAt) || Date.now() + 900_000;
      return;
    }
    // A revoked or expired lease is a hard logout: the platform is authoritative.
    characterSessions.delete(Accounts.key(issued.username));
    if (issued.timer) clearInterval(issued.timer);
    const player = api.core.World.getPlayerByName?.(issued.username);
    if (player) player.requestLogout?.();
  }, 300_000);
  issued.timer.unref?.();
}

/** End a player's hosted gameplay session (logout, disconnect or ban). */
async function closeCharacterSession(username) {
  const key = Accounts.key(username);
  const issued = characterSessions.get(key);
  if (!issued) return;
  characterSessions.delete(key);
  if (issued.timer) clearInterval(issued.timer);
  if (!lease) return;
  try {
    await platformFetch(`/api/server/character-sessions/${encodeURIComponent(issued.token)}?reason=logout`, {
      method: "DELETE", token: lease.token,
    });
  } catch (error) {
    warn(`could not end the gameplay session for ${username}: ${error.message}`);
  }
}

/**
 * Forward any administrative audit events the world emits to the platform, so a
 * host's own grants are recorded centrally. This never gates the action: hosts
 * keep full authority and the audit is best-effort.
 */
async function recordAdministrativeAudit(event) {
  if (!lease || !platform.url || platform.worldSecret) return;
  const payload = event && typeof event === "object" ? event : {};
  const characterName = payload.characterName ?? payload.player?.getUsername?.() ?? null;
  // The audit route keys on the platform character id, so resolve the name the
  // host already acts on. A name that is not registered on this world is audited
  // without a character rather than dropped.
  let characterId = null;
  if (characterName) {
    try {
      characterId = await characterIdFor(characterName);
    } catch (error) {
      warn(`could not resolve ${characterName} for an administrative audit: ${error.message}`);
    }
  }
  try {
    await platformFetch("/api/server/economy/administrative", {
      method: "POST",
      token: lease.token,
      body: {
        characterId,
        operationType: payload.operationType ?? payload.kind ?? "admin",
        itemId: payload.itemId ?? null,
        quantity: payload.quantity ?? null,
        currencyAmount: payload.currencyAmount ?? null,
        actor: payload.actor ?? payload.player?.getUsername?.() ?? "world-host",
        detail: payload.detail ?? null,
      },
    });
  } catch (error) {
    warn(`could not record an administrative audit event: ${error.message}`);
  }
}

/**
 * Store an in-game abuse report in the platform database (hosted mode). A
 * standalone world keeps writing the local JSON-lines file; hosted mode must
 * never fall back to local storage.
 */
async function recordHostedAbuseReport(event) {
  if (!lease || !platform.url || platform.worldSecret) return;
  if (!event || !event.reported) return;
  try {
    await platformFetch("/api/server/abuse-reports", {
      method: "POST",
      token: lease.token,
      body: {
        reporterName: String(event.reporter ?? ""),
        reportedName: String(event.reported),
        category: mapAbuseCategory(event.ruleId),
        ruleId: event.ruleId ?? null,
        details: String(event.rule ?? ""),
      },
    });
  } catch (error) {
    warn(`could not store an abuse report centrally: ${error.message}`);
  }
}

/** Map the OSRS rule id to the platform's report category. */
function mapAbuseCategory(ruleId) {
  switch (Number(ruleId)) {
    case 3: case 6: case 7: case 11: return "cheating";
    case 4: case 12: case 17: case 18: case 20: return "abuse";
    case 5: case 8: case 14: case 21: return "scam";
    case 10: case 16: return "spam";
    case 15: case 19: return "harassment";
    default: return "other";
  }
}

/**
 * Redeem a login password as a platform ticket. Returns { ok: true, characterName }
 * or { ok: false }; `refused` carries the rejection code and message a hosted world
 * should report. Never throws, so the caller decides how to fail.
 */
async function redeemLoginTicket(password, hosted, refused) {
  if (!TICKET_PATTERN.test(password)) {
    refused.code = 3;
    refused.reason = "Please sign in through the PaeScape website to play this world.";
    return { ok: false };
  }
  // An outdated world is draining: it must not accept new gameplay sessions.
  if (hosted && outdated) {
    refused.code = 4;
    refused.reason = "This world is restarting to install an update. Please try again in a moment.";
    return { ok: false };
  }
  if (hosted && !lease) {
    refused.code = 4;
    refused.reason = "This world is not authorised with the PaeScape platform yet. Please try again shortly.";
    return { ok: false };
  }
  let redeemed;
  try {
    const { token, path: ticketPath } = await worldEndpoint("/tickets/redeem");
    if (!token) {
      refused.code = 4;
      refused.reason = "This world is not authorised with the PaeScape platform yet. Please try again shortly.";
      return { ok: false };
    }
    redeemed = await platformFetch(ticketPath, { method: "POST", token, body: { ticket: password } });
  } catch (error) {
    warn(`ticket redemption failed: ${error.message}`);
    // The platform could not be asked. Never fall back to a local character: fail closed.
    refused.code = 8;
    refused.reason = "The PaeScape platform is unavailable; please try again shortly.";
    return { ok: false };
  }
  if (!redeemed.ok || !redeemed.json?.character) {
    refused.code = 3;
    refused.reason = "This login link has expired or is invalid. Please return to the PaeScape website.";
    return { ok: false };
  }
  return { ok: true, characterName: String(redeemed.json.character.name) };
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
  if (result.status === 401 && installation.credential) {
    // We are enrolled but the platform refused the credential: it was revoked or
    // rotated on the website. This is terminal - restarting cannot fix it.
    fatalExit(11, `the installation credential was refused: ${result.json?.error ?? "revoked or invalid"}. Re-enroll this server on the website.`);
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
  bridge.setAuthorized(true);
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
      bridge.setAuthorized(false);
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

/**
 * Warm the authoritative world-state mirror (scoreboards, records, clans, the
 * party chest) once a lease exists, so a plugin's first read on a game tick is a
 * memory lookup rather than a blocking platform round trip. Safe to call more than
 * once: WorldData loads only until the mirror is populated.
 */
function prefetchWorldData() {
  try {
    const loaded = worldData.prefetch();
    if (loaded) log("world state loaded from the platform");
    else if (worldData.isHosted()) warn("world state is not loaded yet; hosted plugins will refuse writes until it is");
  } catch (error) {
    warn(`could not load world state: ${error && error.message ? error.message : error}`);
  }
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
  // A draining world no longer holds a valid lease for new work; stop gating callers
  // (bot startup) on an authorization it cannot deliver.
  bridge.setAuthorized(false);
  warn(`OUTDATED: ${message}`);
  if (leaseTimer) clearTimeout(leaseTimer);
  // Keep the old lease for a moment: the platform rejects stale leases on the
  // persistence routes, so we exchange it for a short, bounded "drain" lease
  // that only permits character saves. Without this the final save during an
  // automatic update would be refused and the server could not shut down safely.
  const staleLease = lease ? lease.token : null;
  if (staleLease) {
    void platformFetch("/api/server/lease/drain", { method: "POST", token: staleLease })
      .then((result) => {
        if (result.ok && result.json?.token) {
          lease = {
            token: String(result.json.token),
            expiresAt: String(result.json.expiresAt),
            generation: Number(result.json.generation) || 0,
            configRevision: Number(lease?.configRevision) || 0,
            contentRevision: lease?.contentRevision ?? null,
            drain: true,
          };
          log("obtained a bounded drain lease for final character saves");
        } else {
          warn(`could not obtain a drain lease (${result.status}${result.json?.error ? `: ${result.json.error}` : ""}); final saves may be refused`);
        }
      })
      .catch((error) => warn(`could not obtain a drain lease: ${error.message}`));
  }
  try {
    api.core.World.sendMessage("The server is updating to a new version and will restart shortly. Please log out safely.");
  } catch { /* world not ready */ }
  setTimeout(() => {
    log("shutting down for an update; the launcher will restart the server");
    try {
      // Exit with the supervisor's distinct "update required" code so the host
      // launcher knows to install the new release and start the server again.
      if (typeof api.core.Server.shutdownForUpdate === "function") {
        api.core.Server.shutdownForUpdate("paescape-update");
      } else {
        api.core.Server.shutdown("paescape-update");
      }
    } catch (error) {
      warn(`graceful shutdown failed, exiting: ${error.message}`);
      process.exit(10);
    }
  }, 5_000).unref?.();
}

/* ------------------------------------------------------------- lifecycle --- */

/**
 * Publish the platform origin, config reader and a live lease-token getter to the
 * shared bridge (plugins/paescape/PaeScapeBridge.js). The persistence adapter reads
 * through these closures, so it always sees the current lease, including one obtained
 * after the hosted enrollment handshake completed.
 */
function publishPlatformAccess() {
  bridge.setPlatformAccess({
    platformOrigin: () => platform.url,
    leaseToken: () => (lease ? lease.token : null),
    readConfig,
  });
}

function start() {
  platform = readConfig();
  publishPlatformAccess();
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
    .then(() => prefetchWorldData())
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
    if (lease) prefetchWorldData();
    if (!installation.credential || !lease) {
      // Retry until the host claims the code (or the world is outdated).
      enrollmentTimer = setInterval(() => {
        if (lease || outdated) return;
        void beginEnrollment().then((enrolled) => {
          if (enrolled?.credential) return handshake().then(() => fetchContentManifest()).then(() => prefetchWorldData());
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
    publishPlatformAccess();
    pluginApi.registerLoginExtension((connection) => ({ preAuthenticate: (event) => preAuthenticate(event, connection) }));
    pluginApi.registerCommand("link", linkCommand, pluginApi.core.PlayerRights.NONE, "Link this character to your PaeScape account");
    pluginApi.onServerStartup(() => start());
    // A logout or disconnect ends the platform gameplay session. The account's
    // other characters cannot log in while a fresh session is live; a crash
    // leaves a stale lease the 60-second reclaim window recovers.
    pluginApi.onPlayerLogout((event) => void closeCharacterSession(event.username));
    pluginApi.onPlayerDisconnect((event) => void closeCharacterSession(event.username));
    // Forward administrative actions to the platform audit trail. Hosts keep
    // full control; this only records what a host already did.
    pluginApi.onCustomEvent("persistence:admin-action", (event) => void recordAdministrativeAudit(event));
    pluginApi.onCustomEvent("report:abuse", (event) => void recordHostedAbuseReport(event));
    pluginApi.onServerShutdown(() => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      if (leaseTimer) clearTimeout(leaseTimer);
      if (enrollmentTimer) clearInterval(enrollmentTimer);
      for (const issued of characterSessions.values()) {
        if (issued.timer) clearInterval(issued.timer);
      }
    });
  },
};
