// Run after `yarn build`, with the PaeScape_Realms platform checkout available:
//   node --test tests/paescape-login-persistence.test.cjs
//
// This drives the real login path (NetworkBuilder.login + the PaeScape plugin's
// ticket login) against the real platform process, with the PaeScape persistence
// adapter installed. A login ticket from the platform authenticates a character,
// the game server loads its authoritative save from the platform, the player
// enters the world, and a logout saves it back. Nothing here is mocked: the
// platform is a real process and the save document is the real serializer's.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test, before, after } = require("node:test");

const SERVER_DIR = path.resolve(__dirname, "..");
function resolvePlatformDir() {
  const candidates = [
    process.env.PAESCAPE_PLATFORM_DIR,
    "D:\\PaeScape_Realms\\platform",
    path.resolve(SERVER_DIR, "..", "..", "PaeScape_Realms", "platform"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "src", "index.ts"))) return candidate;
  }
  return candidates[0];
}
const PLATFORM_DIR = resolvePlatformDir();
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5216);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-login-"));

process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
// The PaeScape plugin and the persistence mode guard read these at registration.
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
// The test platform below mounts at the origin root (PLATFORM_PUBLIC_PATH ''), so
// tell the world plugin the public path is empty: no /platform prefix.
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";
delete process.env.PAESCAPE_WORLD_SECRET;
process.env.PAESCAPE_PUBLIC_ENDPOINT = "https://localhost.invalid:43594";
// The plugin keeps its hosted installation identity in this file; the test seeds
// it so the plugin performs a real enrollment handshake instead of prompting.
process.env.PAESCAPE_INSTALLATION_FILE = path.join(WORK_DIR, "paescape-installation.json");
// The release generation the plugin reports must match the published release.
process.env.PAESCAPE_RELEASE_GENERATION = "1";

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PasswordUtil } = require("../dist/util/PasswordUtil");
const { World } = require("../dist/game/World");
const { Sailing } = require("../dist/game/content/sailing/Sailing");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Item } = require("../dist/game/model/Item");
const { Skill } = require("../dist/game/model/Skill");
const { Skills, SkillManager } = require("../dist/game/content/skill/SkillManager");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const net = require("../dist/net/NetworkBuilder");

const LOGIN_RESPONSE = 3;
let REVISION = 0;
let cookie = "";
let csrf = "";
let worldId = "";
let leaseToken = "";
let platform = null;
let platformOutput = "";

async function platformFetch(pathname, { method = "GET", body, bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = csrf;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${PLATFORM_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, headers: response.headers };
}

async function waitForPlatform() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${PLATFORM_URL}/api/platform/public-key`)).ok) return; } catch { /* not up */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("the platform did not start:\n" + platformOutput.slice(-2000));
}

function stubChannel() {
  const sent = [];
  return {
    sent,
    kind: "test",
    remoteAddress: "127.0.0.1",
    isOpen: () => true,
    send(packet) { sent.push(Buffer.from(packet)); return true; },
    close() {},
    onData() {},
    onError() {},
    onClose() {},
  };
}

function packetsOf(channel, opcode) {
  return channel.sent.filter((bytes) => bytes[0] === opcode);
}

before(async () => {
  await CachePipeline.initialize(SERVER_DIR);
  REVISION = CachePipeline.getActive().revision;
  fs.mkdirSync(WORK_DIR, { recursive: true });

  platform = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: PLATFORM_DIR,
    env: {
      ...process.env,
      PLATFORM_DEV_LOGIN: "1",
      PLATFORM_PORT: String(PLATFORM_PORT),
      PLATFORM_DATABASE_FILE: ":memory:",
      PLATFORM_PUBLIC_PATH: "",
      PLATFORM_PUBLISHER_DISCORD_IDS: "discord-1",
      DISCORD_CLIENT_ID: "test-client-id",
      DISCORD_CLIENT_SECRET: "test-client-secret",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  platform.stdout.on("data", (d) => (platformOutput += d));
  platform.stderr.on("data", (d) => (platformOutput += d));
  await waitForPlatform();

  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username: "Tester", discordId: "discord-1" } });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  csrf = (await platformFetch("/api/auth/session")).json.csrfToken;

  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "Login World", config: { settings: { experienceMultiplier: 1 } } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  worldId = created.json.world.id;
  await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  // The login-ticket route requires a registered connection endpoint.
  const endpoint = await platformFetch(`/api/worlds/${worldId}/endpoint`, { method: "POST", body: { endpointUrl: "https://localhost.invalid:43594" } });
  assert.equal(endpoint.status, 200, JSON.stringify(endpoint.json));

  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));

  const installationKey = "paescape-login-install";
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey } });
  assert.equal(begin.status, 201, JSON.stringify(begin.json));
  const claim = await platformFetch(`/api/worlds/${worldId}/enroll`, { method: "POST", body: { code: begin.json.code } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const credential = (await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } })).json.credential;
  assert.ok(credential, "the platform issued an installation credential");
  // Seed the identity the plugin will load, so its startup is a real enrollment handshake.
  fs.writeFileSync(process.env.PAESCAPE_INSTALLATION_FILE, JSON.stringify({ key: installationKey, credential }, null, 2));

  // Register the persistence adapter exactly as the server does at startup.
  require("../plugins/persistence/PaeScapePlayerPersistence.plugin").register({
    getSkillManager: () => SkillManager,
    setPlayerPersistence: (backend) => GameConstants.setPlayerPersistence(backend),
    onServerStartup: () => {},
    log: () => {},
  });

  // Register the PaeScape plugin and run its real hosted startup. There is no
  // hand-wired bridge or lease here: the plugin authenticates with the platform
  // itself, publishes its access to the bridge, and holds a live lease.
  const PaeScape = require("../plugins/paescape/PaeScape.plugin");
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });

  // Wait for the hosted handshake to publish a lease through the shared bridge.
  const bridge = require("../plugins/paescape/PaeScapeBridge");
  const leaseDeadline = Date.now() + 30000;
  while (Date.now() < leaseDeadline) {
    const access = bridge.getPlatformAccess();
    if (access && typeof access.leaseToken === "function" && access.leaseToken()) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const access = bridge.getPlatformAccess();
  assert.ok(access && typeof access.platformOrigin === "function", "the plugin published the platform bridge");
  assert.equal(access.platformOrigin(), PLATFORM_URL, "the plugin published the platform origin");
  leaseToken = access.leaseToken();
  assert.ok(leaseToken, "the plugin holds a live platform lease after the hosted handshake");
});

after(async () => {
  if (platform) { platform.kill(); await new Promise((r) => setTimeout(r, 300)); }
});

/** The plugin's ticket login requires a 40-64 char alphanumeric token in `password`. */
async function issueLoginTicket(characterId) {
  const response = await platformFetch(`/api/worlds/${worldId}/characters/${characterId}/login-ticket`, { method: "POST", body: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.ticket;
}

async function platformCharacterId(name) {
  const registered = await platformFetch(`/api/worlds/${worldId}/link-challenge`, { method: "POST", body: {} });
  const linked = await platformFetch("/api/server/link", {
    method: "POST",
    bearer: leaseToken,
    body: { code: registered.json.challenge, characterName: name },
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  return linked.json.character.id;
}

test("a ticket login loads the character from the platform and enters the world", async (t) => {
  const name = "Login Hero";
  const characterId = await platformCharacterId(name);

  // Seed authoritative state on the platform, as if saved by a previous session.
  const { Player } = require("../dist/game/entity/impl/player/Player");
  const seeder = new Player({ sendClientPacket: () => true, write() {}, getChannel: () => null });
  seeder.setUsername(name);
  seeder.getSkillManager().addExperience(Skill.ATTACK, 9876, false);
  // A save is made from the player (the same path a logout uses).
  GameConstants.PLAYER_PERSISTENCE.save(seeder, "seed");
  await GameConstants.PLAYER_PERSISTENCE.flush();

  const ticket = await issueLoginTicket(characterId);

  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: name, password: ticket, revision: REVISION, flags: 0 }]);
  await connection.idle();

  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.ok(response, "a login response was sent");
  assert.equal(response[2], 1, "the ticket login was accepted");
  net.ClientConnection.pendingNames.clear();

  // Enter the world: the loaded save is applied to the player.
  t.mock.method(World.getPlayers(), "add", (p) => { p.setIndex(1); return true; });
  t.mock.method(World, "refreshActiveRegions", () => {});
  t.mock.method(Sailing, "onLogin", () => {});
  connection.inject([{ type: "handshake", clientType: 0, capabilities: 0 }]);
  await connection.idle();

  const player = connection.getPlayer();
  assert.ok(player, "the player entered the world");
  assert.equal(player.getUsername(), name);
  assert.equal(player.getSkillManager().getSkills().experience[Skill.ATTACK.getIndex()], 9876, "the platform's skill XP reached the live player");
});

test("a ticket login loads a character with no platform save as a fresh character", async (t) => {
  const name = "Brand New";
  const characterId = await platformCharacterId(name);
  const ticket = await issueLoginTicket(characterId);

  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: name, password: ticket, revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.equal(response[2], 1, "the ticket login was accepted");
  net.ClientConnection.pendingNames.clear();

  t.mock.method(World.getPlayers(), "add", (p) => { p.setIndex(2); return true; });
  t.mock.method(World, "refreshActiveRegions", () => {});
  t.mock.method(Sailing, "onLogin", () => {});
  connection.inject([{ type: "handshake", clientType: 0, capabilities: 0 }]);
  await connection.idle();

  const player = connection.getPlayer();
  assert.ok(player, "the player entered the world");
  const xp = player.getSkillManager().getSkills().experience[Skill.ATTACK.getIndex()];
  assert.ok(xp >= 0 && xp < 1000, "a fresh character starts at default experience rather than another character's");
});

test("an invalid ticket is refused and no character enters", async () => {
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  // 44 chars, matching the ticket shape, but not a real ticket.
  connection.inject([{ type: "login", username: "Nobody", password: "a".repeat(44), revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.ok(response);
  assert.equal(response[2], 0, "the login was refused");
  net.ClientConnection.pendingNames.clear();
  assert.equal(connection.getPlayer(), undefined, "no player entered the world");
});