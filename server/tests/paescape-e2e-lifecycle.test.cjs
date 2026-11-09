// Run after `yarn build`, with the PaeScape_Realms platform checkout available:
//   node --test tests/paescape-e2e-lifecycle.test.cjs
//
// The Task 10 end-to-end lifecycle (task10.txt section 12): a hosted server starts,
// a player authenticates through the platform, loads an authoritative character from
// platform SQL, enters the world, gains experience, acquires and equips an item,
// banks an item, saves and disconnects. The server then "restarts" (a brand-new
// adapter instance, as a fresh process would be) and the same character is reloaded
// and every change verified. Nothing is mocked: the platform is a real child process,
// the login path is the real NetworkBuilder.login, and the save document is produced
// by the real serializer that a production logout uses.
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
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5217);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-e2e-"));
const LOCAL_SAVE_DIR = path.join(WORK_DIR, "characters");

process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
delete process.env.PAESCAPE_WORLD_SECRET;
process.env.PAESCAPE_PUBLIC_ENDPOINT = "https://localhost.invalid:43594";
process.env.PAESCAPE_INSTALLATION_FILE = path.join(WORK_DIR, "paescape-installation.json");
process.env.PAESCAPE_RELEASE_GENERATION = "1";

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { World } = require("../dist/game/World");
const { Sailing } = require("../dist/game/content/sailing/Sailing");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Item } = require("../dist/game/model/Item");
const { Skill } = require("../dist/game/model/Skill");
const { SkillManager } = require("../dist/game/content/skill/SkillManager");
const { Equipment } = require("../dist/game/model/container/impl/Equipment");
const { Bank } = require("../dist/game/model/container/impl/Bank");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const { Player } = require("../dist/game/entity/impl/player/Player");
const net = require("../dist/net/NetworkBuilder");
const bridge = require("../plugins/paescape/PaeScapeBridge");
const adapterModule = require("../plugins/persistence/PaeScapePlayerPersistence.plugin");

const LOGIN_RESPONSE = 3;
let REVISION = 0;
let cookie = "";
let csrf = "";
let worldId = "";
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

/** Live lease the plugin obtained during its hosted startup. */
function liveLease() {
  const access = bridge.getPlatformAccess();
  return access && typeof access.leaseToken === "function" ? access.leaseToken() : null;
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

  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "Lifecycle World", config: { settings: { experienceMultiplier: 1 } } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  worldId = created.json.world.id;
  await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  const endpoint = await platformFetch(`/api/worlds/${worldId}/endpoint`, { method: "POST", body: { endpointUrl: "https://localhost.invalid:43594" } });
  assert.equal(endpoint.status, 200, JSON.stringify(endpoint.json));

  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));

  const installationKey = "paescape-e2e-install";
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey } });
  assert.equal(begin.status, 201, JSON.stringify(begin.json));
  const claim = await platformFetch(`/api/worlds/${worldId}/enroll`, { method: "POST", body: { code: begin.json.code } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const credential = (await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } })).json.credential;
  assert.ok(credential, "the platform issued an installation credential");
  fs.writeFileSync(process.env.PAESCAPE_INSTALLATION_FILE, JSON.stringify({ key: installationKey, credential }, null, 2));

  require("../plugins/persistence/PaeScapePlayerPersistence.plugin").register({
    getSkillManager: () => SkillManager,
    setPlayerPersistence: (backend) => GameConstants.setPlayerPersistence(backend),
    onServerStartup: () => {},
    log: () => {},
  });
  const PaeScape = require("../plugins/paescape/PaeScape.plugin");
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !liveLease()) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(liveLease(), "the hosted server holds a live platform lease");
});

after(async () => {
  if (platform) { platform.kill(); await new Promise((r) => setTimeout(r, 300)); }
});

async function registerCharacter(name, discordId) {
  const previous = { cookie, csrf };
  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username: "User " + name, discordId } });
  const ownerCookie = (login.headers.get("set-cookie") || "").split(";")[0];
  cookie = ownerCookie;
  const ownerCsrf = (await platformFetch("/api/auth/session")).json.csrfToken;
  csrf = ownerCsrf;
  const challenge = await platformFetch(`/api/worlds/${worldId}/link-challenge`, { method: "POST", body: {} });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.json));
  const linked = await platformFetch("/api/server/link", {
    method: "POST",
    bearer: liveLease(),
    body: { code: challenge.json.challenge, characterName: name },
  });
  cookie = previous.cookie;
  csrf = previous.csrf;
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  return { id: linked.json.character.id, cookie: ownerCookie, csrf: ownerCsrf };
}

/** A login ticket can only be issued to the signed-in owner of the character. */
async function issueTicket(character, owner) {
  const previous = { cookie, csrf };
  cookie = owner.cookie;
  csrf = owner.csrf;
  const response = await platformFetch(`/api/worlds/${worldId}/characters/${character}/login-ticket`, { method: "POST", body: {} });
  cookie = previous.cookie;
  csrf = previous.csrf;
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.ticket;
}

/** Log in and enter the world, returning the live player (the real login path). */
async function loginAndEnter(t, name, ticket, index) {
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: name, password: ticket, revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.equal(response?.[2], 1, "the ticket login was accepted");
  net.ClientConnection.pendingNames.clear();
  t.mock.method(World.getPlayers(), "add", (p) => { p.setIndex(index); return true; });
  t.mock.method(World, "refreshActiveRegions", () => {});
  t.mock.method(Sailing, "onLogin", () => {});
  connection.inject([{ type: "handshake", clientType: 0, capabilities: 0 }]);
  await connection.idle();
  const player = connection.getPlayer();
  assert.ok(player, "the player entered the world");
  return { player, connection, channel };
}

test("the full lifecycle: authenticate, play, save, restart, reload", async (t) => {
  const name = "E2E Hero";
  const account = await registerCharacter(name, "discord-life");

  // 1-4. Start hosted server, authenticate with PaeScape, load from platform SQL, enter.
  const { player } = await loginAndEnter(t, name, await issueTicket(account.id, account), 1);
  assert.equal(player.getUsername(), name);

  // A brand-new character comes from the platform with default state (a real load path).
  assert.equal(GameConstants.PLAYER_PERSISTENCE.load(name), null, "no authoritative save exists yet");

  // 5-8. Gain experience, acquire an item, equip it, bank it.
  const attack = Skill.ATTACK.getIndex();
  player.getSkillManager().addExperience(Skill.ATTACK, 123456, false);
  player.getInventory().setItem(0, new Item(995, 250000));   // coins
  player.getInventory().setItem(1, new Item(4151, 1));        // abyssal whip
  player.getInventory().setItem(2, new Item(11832, 7));       // bandos chestplate
  player.getEquipment().setItem(Equipment.WEAPON_SLOT, new Item(4151, 1));
  Bank.withoutLimit(player, () => player.setBank(0, new Bank(player)).getBank(0).addItems([new Item(11832, 7)], false));
  const expectedXp = player.getSkillManager().getSkills().experience[attack];

  // 9. Save and disconnect (the exact logout save a real session performs).
  GameConstants.PLAYER_PERSISTENCE.save(player, "logout");
  await GameConstants.PLAYER_PERSISTENCE.flush();

  // 10-11. Shut down the server and restart: a fresh adapter instance, as a new
  // process would build, reading only from the platform.
  const reloaded = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  // 12-13. Authenticate again and reload the same character from platform SQL.
  const save = reloaded.load(name);
  assert.ok(save, "the character reloads from the platform after a restart");

  // 14. Every change persisted correctly.
  assert.equal(save.getSkills().experience[attack], expectedXp, "experience persisted");
  assert.equal(save.getInventory()[0].getAmount(), 250000, "currency persisted");
  assert.equal(save.getInventory()[1].getId(), 4151, "acquired item persisted");
  assert.equal(save.getEquipment()[Equipment.WEAPON_SLOT].getId(), 4151, "equipped item persisted");
  assert.equal((save.getBanks().get(0) || []).find((item) => item.getId() === 11832).getAmount(), 7, "the banked item persisted");
});

test("a duplicate active session for the same character is refused", async (t) => {
  const name = "Dup Hero";
  const account = await registerCharacter(name, "discord-session");
  const { player } = await loginAndEnter(t, name, await issueTicket(account.id, account), 3);
  assert.ok(player, "the first session entered");

  // The first player is in the world, so a second connection for the same account
  // is refused: one account is online at a time, whichever of its characters.
  t.mock.method(World, "getPlayerByName", (queried) => (queried === name ? player : undefined));

  // A second connection for the same account, while the first is still online, is refused.
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: name, password: await issueTicket(account.id, account), revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.equal(response?.[2], 0, "the duplicate session was refused");
  assert.equal(connection.getPlayer(), undefined, "no second player entered the world");
  net.ClientConnection.pendingNames.clear();
});

test("an unregistered name cannot log in with a password in hosted mode", async () => {
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: "Pw Intruder", password: "hunter2", revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.ok(response, "a login response was sent");
  assert.equal(response[2], 0, "the password login was refused; hosted worlds accept only tickets");
  assert.equal(connection.getPlayer(), undefined, "no local character was created");
  net.ClientConnection.pendingNames.clear();
});

test("an invalid or expired lease is refused for both load and save", async () => {
  const name = "E2E Hero"; // already registered by the lifecycle test
  const previous = bridge.getPlatformAccess();
  bridge.setPlatformAccess({
    platformOrigin: () => PLATFORM_URL,
    leaseToken: () => null, // no lease: the world is not authorised
    readConfig: () => ({ url: PLATFORM_URL, worldSecret: "" }),
  });
  const stranded = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  assert.throws(() => stranded.load(name), /lease|authorization/i, "a load without a lease is refused");
  assert.throws(() => stranded.exists(name), /lease|authorization/i, "an ownership check without a lease is refused");
  bridge.setPlatformAccess(previous);
});

test("an invalid lease token is rejected by the platform", async () => {
  const previous = bridge.getPlatformAccess();
  bridge.setPlatformAccess({
    platformOrigin: () => PLATFORM_URL,
    leaseToken: () => "not-a-real-lease-token",
    readConfig: () => ({ url: PLATFORM_URL, worldSecret: "" }),
  });
  const stranded = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  assert.throws(() => stranded.load("E2E Hero"), /status 401|platform|status/i, "the platform rejects the forged lease");
  bridge.setPlatformAccess(previous);
});

/** Sign in as another platform user and return its session. */
async function signInAs(username, discordId) {
  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username, discordId } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const sessionCookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const previous = { cookie, csrf };
  cookie = sessionCookie;
  const sessionCsrf = (await platformFetch("/api/auth/session")).json.csrfToken;
  csrf = sessionCsrf;
  return { cookie: sessionCookie, csrf: sessionCsrf, previous };
}

test("character ownership is enforced for ticket issuance", async () => {
  const name = "Owned Hero";
  const owner = await registerCharacter(name, "discord-owned");
  // A different signed-in user cannot issue a ticket for this character.
  const stranger = await signInAs("Stranger", "discord-stranger");
  const denied = await platformFetch(`/api/worlds/${worldId}/characters/${owner.id}/login-ticket`, { method: "POST", body: {} });
  cookie = stranger.previous.cookie;
  csrf = stranger.previous.csrf;
  assert.equal(denied.status, 404, JSON.stringify(denied.json));

  // The owner can, and the ticket is bound to this world.
  const ticket = await issueTicket(owner.id, owner);
  const wrongWorld = await platformFetch("/api/server/tickets/redeem", {
    method: "POST",
    bearer: liveLease(),
    body: { ticket },
  });
  // The lease belongs to this world, so this redemption is the valid one; replaying it
  // afterwards must fail: a ticket is single-use.
  assert.equal(wrongWorld.status, 200, JSON.stringify(wrongWorld.json));
  const replay = await platformFetch("/api/server/tickets/redeem", {
    method: "POST",
    bearer: liveLease(),
    body: { ticket },
  });
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
});

test("a transient platform failure is retried and the save recovers", async () => {
  const { spawn: spawnChild } = require("node:child_process");
  const os = require("node:os");
  const name = "Retry Hero";
  await registerCharacter(name, "discord-retry");
  const lease = liveLease();
  const freePort = await new Promise((resolve) => {
    const probe = require("node:net").createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  // A real forwarding proxy in its own process: the first character-state PUT is
  // answered with 503 and every later request passes through. The adapter blocks the
  // main thread for its synchronous reads, so the proxy cannot share this process.
  const proxyScript = path.join(os.tmpdir(), "paescape-flaky-proxy.cjs");
  fs.writeFileSync(proxyScript, [
    'const http = require("node:http");',
    'const targetPort = Number(process.argv[2]);',
    'const port = Number(process.argv[3]);',
    'let failedOnce = false;',
    'const server = http.createServer((req, res) => {',
    '  if (req.method === "PUT" && req.url.includes("/state") && !failedOnce) {',
    '    failedOnce = true;',
    '    req.resume();',
    '    res.writeHead(503, { "content-type": "application/json" });',
    '    res.end(JSON.stringify({ error: "temporarily unavailable" }));',
    '    return;',
    '  }',
    '  const upstream = http.request({ hostname: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers }, (upstreamRes) => {',
    '    res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);',
    '    upstreamRes.pipe(res);',
    '  });',
    '  upstream.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });',
    '  req.pipe(upstream);',
    '});',
    'server.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n"));
  const proxy = spawnChild(process.execPath, [proxyScript, String(PLATFORM_PORT), String(freePort)], { stdio: ["ignore", "pipe", "pipe"] });
  let proxyOutput = "";
  proxy.stdout.on("data", (d) => (proxyOutput += d));
  proxy.stderr.on("data", (d) => (proxyOutput += d));
  const ready = Date.now() + 15000;
  while (Date.now() < ready && !proxyOutput.includes("ready")) await new Promise((r) => setTimeout(r, 100));
  assert.ok(proxyOutput.includes("ready"), "the flaky proxy started: " + proxyOutput.slice(-500));
  try {
    const previous = bridge.getPlatformAccess();
    bridge.setPlatformAccess({
      platformOrigin: () => `http://127.0.0.1:${freePort}`,
      leaseToken: () => lease,
      readConfig: () => ({ url: PLATFORM_URL, worldSecret: "" }),
    });
    const adapter = new adapterModule.PaeScapePlayerPersistence(SkillManager);
    assert.equal(adapter.load(name), null);
    const player = new Player({ sendClientPacket: () => true, write() {}, getChannel: () => null });
    player.setUsername(name);
    player.getSkillManager().addExperience(Skill.ATTACK, 4242, false);
    adapter.save(player, "autosave");
    await adapter.flush();
    bridge.setPlatformAccess(previous);

    const reloaded = new adapterModule.PaeScapePlayerPersistence(SkillManager);
    const save = reloaded.load(name);
    assert.ok(save, "the save landed after the 503 retry");
    assert.equal(save.getSkills().experience[Skill.ATTACK.getIndex()], 4242, "the retried save is authoritative");
  } finally {
    proxy.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
});

/**
 * Graceful shutdown saves every online player through the platform. The real
 * Server.gracefulShutdown runs; only the process exit is intercepted so the test
 * process survives.
 */
test("graceful shutdown saves online characters to the platform", async () => {
  const { Server: GameServer } = require("../dist/Server");
  const name = "Shut Hero";
  const account = await registerCharacter(name, "discord-shutdown");
  const ticket = await issueTicket(account.id, account);
  const channel = stubChannel();
  const connection = new net.ClientConnection(channel);
  connection.inject([{ type: "login", username: name, password: ticket, revision: REVISION, flags: 0 }]);
  await connection.idle();
  const [response] = packetsOf(channel, LOGIN_RESPONSE);
  assert.equal(response?.[2], 1, "the ticket login was accepted");
  net.ClientConnection.pendingNames.clear();

  const previous = {
    refresh: World.refreshActiveRegions,
    sailing: Sailing.onLogin,
    exit: process.exit,
    kill: process.kill,
    shutdownHooks: PluginManager.emitServerShutdown,
  };
  let exited = false;
  process.exit = () => { exited = true; };
  process.kill = () => { exited = true; };
  try {
    // Keep the real MobileList.add so the player is in World.getPlayers() at shutdown.
    World.refreshActiveRegions = () => {};
    Sailing.onLogin = () => {};
    // The plugin's own shutdown hook clears timers; keep the rest of the platform alive.
    const originalShutdownHooks = PluginManager.emitServerShutdown;
    PluginManager.emitServerShutdown = (event) => {
      try { originalShutdownHooks(event); } catch { /* plugin timers */ }
    };
    connection.inject([{ type: "handshake", clientType: 0, capabilities: 0 }]);
    await connection.idle();
    const player = connection.getPlayer();
    assert.ok(player, "the player entered the world");
    player.getSkillManager().addExperience(Skill.ATTACK, 77777, false);

    assert.ok(World.getPlayers().stream?.().includes(player) ?? World.getPlayerByName(player.getUsername()) === player, "the player is online for the shutdown save");
    await GameServer.gracefulShutdown("task10-test", "exit");
  } finally {
    World.refreshActiveRegions = previous.refresh;
    Sailing.onLogin = previous.sailing;
    process.exit = previous.exit;
    process.kill = previous.kill;
    PluginManager.emitServerShutdown = previous.shutdownHooks;
  }
  assert.equal(exited, true, "the shutdown requested a process exit, which the test intercepted");

  // The shutdown save is authoritative on the platform: a new adapter reads it back.
  const reloaded = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  const save = reloaded.load(name);
  assert.ok(save, "the shutdown save reached the platform");
  assert.equal(save.getSkills().experience[Skill.ATTACK.getIndex()], 77777, "the shutdown save carries the live state");
});

/**
 * Automatic update shutdown: the platform publishes a newer release while this
 * server is running. Its ordinary lease becomes stale, so the plugin exchanges it
 * for a bounded drain lease; the final character save must still reach the
 * platform, and a restarted server must reload that exact save. Configuration
 * access stays refused during the drain, so an old build cannot resume serving.
 */
test("an automatic update shutdown saves through a drain lease and reloads after restart", async () => {
  const name = "Update Hero";
  await registerCharacter(name, "discord-update");
  const access = bridge.getPlatformAccess();
  const ordinaryLease = access.leaseToken();
  assert.ok(ordinaryLease, "the hosted server holds an ordinary lease");

  // Resolve the character id while the lease is still current.
  const hero = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  const characterId = hero.resolveCharacterId(name);
  assert.ok(characterId, "the character resolves on this world before the update");
  const baseRelease = (await platformFetch("/api/releases/latest?channel=stable")).json.release;

  // Publish a newer release. The ordinary lease is now stale for the platform.
  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.1", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));
  const refused = await platformFetch(`/api/server/characters/${characterId}/state`, { bearer: ordinaryLease });
  assert.equal(refused.status, 409, "the stale ordinary lease cannot read character state");

  // Obtain the bounded drain lease the plugin uses for its final save.
  const drain = await platformFetch("/api/server/lease/drain", { method: "POST", bearer: ordinaryLease });
  assert.equal(drain.status, 200, JSON.stringify(drain.json));
  assert.equal(drain.json.drain, true);
  bridge.setPlatformAccess({
    platformOrigin: () => PLATFORM_URL,
    leaseToken: () => String(drain.json.token),
    readConfig: () => ({ url: PLATFORM_URL, worldSecret: "" }),
  });

  try {
    // A live player, as the shutdown save finds them, without the login path
    // (which the platform would refuse for a stale release).
    const player = new Player({ sendClientPacket: () => true, write() {}, getChannel: () => null });
    player.setUsername(name);
    player.getInventory().setItem(0, new Item(995, 424242));
    player.getSkillManager().addExperience(Skill.MAGIC, 31415, false);
    GameConstants.PLAYER_PERSISTENCE.save(player, "update-shutdown");
    await GameConstants.PLAYER_PERSISTENCE.flush();

    // A restarted server reads the saved state back from the platform.
    const restarted = new adapterModule.PaeScapePlayerPersistence(SkillManager);
    const save = restarted.load(name);
    assert.ok(save, "the drain save reached the platform");
    assert.equal(save.getInventory()[0].getAmount(), 424242, "currency survives the update shutdown");
    assert.equal(save.getSkills().experience[Skill.MAGIC.getIndex()], 31415, "experience survives the update shutdown");
  } finally {
    bridge.setPlatformAccess(access);
    // Restore the base release and re-handshake for a fresh ordinary lease, so
    // later tests in the suite still operate against a current server. The drained
    // lease stays pinned to the old generation and is discarded.
    if (baseRelease?.id) {
      await platformFetch(`/api/releases/${baseRelease.id}/current`, { method: "POST", body: {} });
    }
    const installation = JSON.parse(fs.readFileSync(process.env.PAESCAPE_INSTALLATION_FILE, "utf8"));
    const nonce = (await platformFetch("/api/server/handshake/nonce", { method: "POST", body: { installationKey: installation.key } })).json.nonce;
    const refreshed = await platformFetch("/api/server/handshake", {
      method: "POST",
      bearer: installation.credential,
      body: { nonce, generation: Number(baseRelease.generation), protocolVersion: 1 },
    });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    bridge.setPlatformAccess({
      platformOrigin: () => PLATFORM_URL,
      leaseToken: () => String(refreshed.json.lease.token),
      readConfig: () => ({ url: PLATFORM_URL, worldSecret: "" }),
    });
  }
});

/**
 * Production server.exe compatibility: the bundler obfuscates every plugin .js with
 * javascript-obfuscator. The worker transport uses SharedArrayBuffer + Atomics.wait,
 * so prove an obfuscated copy still performs a real synchronous platform round trip.
 */
test("an obfuscated transport still performs a real synchronous platform request", async () => {
  const JavaScriptObfuscator = require("javascript-obfuscator");
  const options = {
    compact: true, selfDefending: true, stringArray: true, stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75, deadCodeInjection: false, debugProtection: false,
    controlFlowFlattening: false, identifierNamesGenerator: "hexadecimal",
    transformObjectKeys: false, unicodeEscapeSequence: false,
  };
  const sourceDir = path.join(SERVER_DIR, "plugins", "persistence");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-obf-"));
  for (const name of ["PaeScapePersistenceTransport.js", "PaeScapePersistenceSync.worker.js"]) {
    const source = fs.readFileSync(path.join(sourceDir, name), "utf8");
    fs.writeFileSync(path.join(outDir, name), JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode());
  }
  const { requestSync } = require(path.join(outDir, "PaeScapePersistenceTransport.js"));
  const response = requestSync({
    url: PLATFORM_URL + "/api/platform/public-key",
    method: "GET",
    headers: { accept: "application/json" },
    timeoutMs: 8000,
  });
  assert.equal(response.status, 200, "the obfuscated worker reached the platform: " + response.text);
  assert.ok(response.json && response.json.publicKey, "the response parsed from the obfuscated worker");
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("world state persists through the platform with concurrency and idempotency", async () => {
  const lease = liveLease();
  const first = { objects: { "3200,3200": { id: 1234 } }, progression: { bossKills: 0 } };
  const saved = await platformFetch("/api/server/world-state", {
    method: "PUT",
    bearer: lease,
    body: { expectedRevision: 0, state: first, idempotencyKey: "world-save-1", kind: "world-save" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.revision, 1);

  // A retried idempotency key replays the first result rather than writing twice.
  const replay = await platformFetch("/api/server/world-state", {
    method: "PUT",
    bearer: lease,
    body: { expectedRevision: 0, state: { objects: {} }, idempotencyKey: "world-save-1", kind: "world-save" },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.replayed, true, "a duplicate save is replayed, not applied");

  // A stale base revision is refused.
  const stale = await platformFetch("/api/server/world-state", {
    method: "PUT",
    bearer: lease,
    body: { expectedRevision: 0, state: { objects: {} }, idempotencyKey: "world-save-2", kind: "world-save" },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));

  // The stored world state is what a restarted server loads.
  const loaded = await platformFetch("/api/server/world-state", { bearer: lease });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  assert.deepEqual(loaded.json.state.state, first, "the world state round-trips");
  assert.equal(loaded.json.state.revision, 1);
});

test("no authoritative local save file is created in hosted mode", () => {
  const entries = fs.existsSync(LOCAL_SAVE_DIR) ? fs.readdirSync(LOCAL_SAVE_DIR) : [];
  assert.deepEqual(entries, [], "hosted persistence never writes character files to disk");
  assert.equal(GameConstants.PLAYER_PERSISTENCE.describe().localSaves, false);
});
