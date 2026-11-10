// Run after `yarn build`, with the PaeScape_Realms platform checkout available:
//   node --test tests/paescape-persistence.test.cjs
//
// This is not a mocked test. It boots the real PaeScape platform as a separate
// process (in-memory SQLite) and drives the real PaeScape persistence adapter,
// the real synchronous platform transport, and the real player serialization for
// every load and save. The adapter is synchronous, so the platform must live in
// another process for its HTTP server to make progress while a load blocks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test, before, after } = require("node:test");

const SERVER_DIR = path.resolve(__dirname, "..");
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5211);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
// The adapter and the guards on the local backends agree on hosted mode through
// this env var + the world config, so set it before anything reads the mode.
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
// The test platform below mounts at the origin root (PLATFORM_PUBLIC_PATH ''), so
// tell the world plugin the public path is empty: no /platform prefix.
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";
delete process.env.PAESCAPE_WORLD_SECRET;

/** The PaeScape platform checkout. Override with PAESCAPE_PLATFORM_DIR. */
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
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-persist-"));
const LOCAL_SAVE_DIR = path.join(SAVE_DIR, "characters");

// Keep accounts and display names off the real data directory, before `dist` loads.
process.env.TSPS_ACCOUNTS_FILE = path.join(SAVE_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(SAVE_DIR, "display-names.json");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const { Item } = require("../dist/game/model/Item");
const { Skill } = require("../dist/game/model/Skill");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { Bank } = require("../dist/game/model/container/impl/Bank");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");

let platform = null;
let platformOutput = "";
let cookie = "";
let csrf = "";
let worldId = "";
let worldTwoId = "";
let leaseToken = "";
let leaseTwoToken = "";

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
    try {
      const response = await fetch(`${PLATFORM_URL}/api/platform/public-key`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("the platform did not start:\n" + platformOutput.slice(-2000));
}

/** Sign in as a distinct platform user and return { cookie, csrf, userId }. */
async function signInAs(username, discordId) {
  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username, discordId } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const setCookie = login.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0] || "";
  assert.ok(sessionCookie, "the dev login set a session cookie");
  const previous = { cookie, csrf };
  cookie = sessionCookie;
  const session = await platformFetch("/api/auth/session");
  assert.equal(session.json.authenticated, true, JSON.stringify(session.json));
  csrf = session.json.csrfToken;
  return { cookie: sessionCookie, csrf, userId: session.json.user.id, previous };
}

/** Enroll an installation for a world and return a live lease token. */
async function enrollAndLease(id, keySuffix) {
  const installationKey = `paescape-test-install-${keySuffix}`;
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey, label: keySuffix } });
  assert.equal(begin.status, 201, JSON.stringify(begin.json));
  const claim = await platformFetch(`/api/worlds/${id}/enroll`, { method: "POST", body: { code: begin.json.code } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const complete = await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } });
  assert.equal(complete.status, 201, JSON.stringify(complete.json));
  const credential = complete.json.credential;
  const nonce = (await platformFetch("/api/server/handshake/nonce", { method: "POST", body: { installationKey } })).json.nonce;
  const handshake = await platformFetch("/api/server/handshake", {
    method: "POST",
    bearer: credential,
    body: { nonce, generation: 1, protocolVersion: 1 },
  });
  assert.equal(handshake.status, 200, JSON.stringify(handshake.json));
  return handshake.json.lease.token;
}

/**
 * Register a world character for a signed-in user via the lease-authorised link.
 * Pass a distinct `discordId` per character: the three-per-world limit is per user.
 */
async function registerCharacter(name, { id = worldId, token = leaseToken, discordId = "discord-1" } = {}) {
  const previous = { cookie, csrf };
  const session = await signInAs("User " + name, discordId);
  const challenge = await platformFetch(`/api/worlds/${id}/link-challenge`, { method: "POST", body: {} });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.json));
  const linked = await platformFetch("/api/server/link", {
    method: "POST",
    bearer: token,
    body: { code: challenge.json.challenge, characterName: name },
  });
  cookie = previous.cookie;
  csrf = previous.csrf;
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  return linked.json.character;
}

const bridge = require("../plugins/paescape/PaeScapeBridge");
const adapterModule = require("../plugins/persistence/PaeScapePlayerPersistence.plugin");
const { SkillManager } = require("../dist/game/content/skill/SkillManager");
const { isHostedPersistence } = require("../plugins/persistence/PaeScapePersistenceMode");

let active = null;
/** Build and register an adapter against the real platform. */
function installAdapter(origin = PLATFORM_URL, token = leaseToken) {
  bridge.setPlatformAccess({
    platformOrigin: () => origin,
    leaseToken: () => token,
    readConfig: () => ({ url: origin, worldSecret: "" }),
  });
  active = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  GameConstants.setPlayerPersistence(active);
  return active;
}

function makePlayer(name) {
  const session = { sendClientPacket: () => true, write() {}, getChannel: () => null };
  const player = new Player(session);
  player.setUsername(name);
  return player;
}

const users = {};

before(async () => {
  await CachePipeline.initialize(SERVER_DIR);
  fs.mkdirSync(LOCAL_SAVE_DIR, { recursive: true });

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

  const owner = await signInAs("Tester", "discord-1");
  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "Persistence World", config: { settings: { experienceMultiplier: 1 } } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  worldId = created.json.world.id;
  // Going live is what makes a world playable (`canPlay`), which a link challenge requires.
  const live = await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  assert.equal(live.status, 200, JSON.stringify(live.json));

  const second = await platformFetch("/api/worlds", { method: "POST", body: { name: "Other World" } });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  worldTwoId = second.json.world.id;
  await platformFetch(`/api/worlds/${worldTwoId}/go-live`, { method: "POST", body: {} });

  // Publish release generation 1, which every lease must match.
  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));

  leaseToken = await enrollAndLease(worldId, "one");
  leaseTwoToken = await enrollAndLease(worldTwoId, "two");

  // Each character belongs to a distinct user: the 3-per-world limit is per user.
  users.owner = owner;
  users.two = await signInAs("Second", "discord-2");
  cookie = owner.cookie;
  csrf = owner.csrf;
});

after(async () => {
  if (platform) {
    platform.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});

test("hosted mode is detected from the platform configuration", () => {
  assert.equal(isHostedPersistence(), true);
});

test("a registered character with no save loads as null (new character creation)", async () => {
  installAdapter();
  await registerCharacter("Fresh Hero", { discordId: "discord-fresh" });
  assert.equal(active.load("Fresh Hero"), null, "a registered character with no save loads as null");
  assert.equal(active.exists("Fresh Hero"), true);
  assert.equal(active.exists("Never Made"), false);
});

test("skills, inventory, equipment, bank and progression round-trip through the platform", async () => {
  installAdapter();
  await registerCharacter("Round Trip", { discordId: "discord-round" });
  assert.equal(active.load("Round Trip"), null);

  const player = makePlayer("Round Trip");
  player.getInventory().setItem(0, new Item(995, 123456));           // coins (currency)
  player.getInventory().setItem(1, new Item(4151, 1));               // abyssal whip
  player.getEquipment().setItem(Equipment.WEAPON_SLOT, new Item(1321, 1));
  Bank.withoutLimit(player, () => player.setBank(0, new Bank(player)).getBank(0).addItems([new Item(11832, 5)], false));
  player.getSkillManager().addExperience(Skill.ATTACK, 5000, false);
  PlayerSave.persistAttribute("quest:test-progress", null);
  player.setAttribute("quest:test-progress", { step: 3 });
  const before = PlayerSave.fromPlayer(player);

  active.save(player, "logout");
  await active.flush();

  // A fresh adapter (a "new server process") reads everything back from the platform.
  const reloaded = installAdapter();
  const save = reloaded.load("Round Trip");
  assert.ok(save, "the character loads from the platform");
  assert.equal(save.getInventory()[0].getId(), 995);
  assert.equal(save.getInventory()[0].getAmount(), 123456, "currency persists");
  assert.equal(save.getInventory()[1].getId(), 4151);
  assert.equal(save.getEquipment()[Equipment.WEAPON_SLOT].getId(), 1321, "equipment persists");
  assert.equal((save.getBanks().get(0) || [])[0].getId(), 11832, "the bank persists");
  assert.equal(save.getSkills().experience[Skill.ATTACK.getIndex()], before.getSkills().experience[Skill.ATTACK.getIndex()], "experience persists");
  assert.deepEqual(save.attributes["quest:test-progress"], { step: 3 }, "progression attributes persist");
});

test("saving twice from one session writes sequentially and the latest value wins", async () => {
  installAdapter();
  await registerCharacter("Revision Hero", { discordId: "discord-rev" });
  const player = makePlayer("Revision Hero");
  player.getInventory().setItem(0, new Item(995, 10));
  active.save(player, "autosave");
  player.getInventory().setItem(0, new Item(995, 20));
  active.save(player, "autosave");
  await active.flush();
  assert.ok(active.describe().writesCompleted >= 2, "both saves completed rather than conflicting");

  const reloaded = installAdapter();
  const save = reloaded.load("Revision Hero");
  assert.equal(save.getInventory()[0].getAmount(), 20, "the latest value wins and nothing is lost");
});

test("a save whose base revision is stale is refused, not clobbered", async () => {
  installAdapter();
  await registerCharacter("Conflict Hero", { discordId: "discord-conflict" });
  const player = makePlayer("Conflict Hero");
  player.getInventory().setItem(0, new Item(995, 50));
  active.save(player, "autosave");
  await active.flush();

  // Advance the platform's revision behind the adapter's back.
  const id = active.resolveCharacterId("Conflict Hero");
  const other = await platformFetch(`/api/server/characters/${id}/state`, {
    method: "PUT",
    bearer: leaseToken,
    body: { expectedRevision: 1, idempotencyKey: "external-write-1", state: { sentinel: true } },
  });
  assert.equal(other.status, 200, JSON.stringify(other.json));

  // The adapter still believes revision 1 is current, so its next write conflicts
  // and must surface as a failure rather than a silent success.
  active.save(player, "autosave");
  await assert.rejects(active.flush(), (error) => error.status === 409);
});

test("loading is refused when the world holds no valid lease", async () => {
  installAdapter(PLATFORM_URL, "");
  assert.throws(() => active.load("Round Trip"), /lease|authorization/i, "no lease means no load, and no local fallback");
});

test("loading is refused when the platform is unreachable", async () => {
  installAdapter("http://127.0.0.1:1", leaseToken);
  assert.throws(() => active.load("Round Trip"), /could not|platform|status/i);
});

test("cross-world isolation: a name from another world is never visible", async () => {
  // Register a character on world two using world two's lease and the owner account.
  await registerCharacter("Other World Hero", { id: worldTwoId, token: leaseTwoToken, discordId: "discord-1" });
  installAdapter(); // world one's adapter
  assert.equal(active.resolveCharacterId("Other World Hero"), null, "world one cannot resolve another world's character");
  assert.equal(active.load("Other World Hero"), null);
});

test("an outdated lease is refused by the platform", async () => {
  // Publish generation 2: the world-one lease now belongs to a previous release.
  cookie = users.owner.cookie;
  csrf = users.owner.csrf;
  const published = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.1", channel: "stable" } });
  assert.equal(published.status, 201, JSON.stringify(published.json));
  installAdapter(PLATFORM_URL, leaseToken);
  assert.throws(() => active.load("Round Trip"), /status 409|outdated|platform/i, "a stale lease cannot read authoritative state");
});

test("no local authoritative save is created in hosted mode", () => {
  const entries = fs.existsSync(LOCAL_SAVE_DIR) ? fs.readdirSync(LOCAL_SAVE_DIR) : [];
  assert.deepEqual(entries, [], "the hosted adapter never writes character files to disk");
  assert.equal(active.describe().localSaves, false);
});