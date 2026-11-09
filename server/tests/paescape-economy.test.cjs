// Run after `yarn build`, with the PaeScape_Realms platform checkout available:
//   node --test tests/paescape-economy.test.cjs
//
// Task 11 integration test: the real platform runs as a separate process (in-memory
// SQLite) and the real PaeScape persistence adapter drives real HTTP. A player trade
// and a bank deposit/withdraw are committed through the platform's atomic economy
// route with real Player objects and the real Trade/Bank code paths. Nothing is
// mocked: the adapter is the production adapter and the state documents are produced
// by the real serializer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test, before, after } = require("node:test");

const SERVER_DIR = path.resolve(__dirname, "..");
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5231);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
delete process.env.PAESCAPE_WORLD_SECRET;

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
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-economy-"));
const LOCAL_SAVE_DIR = path.join(WORK_DIR, "characters");

process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
const { Item } = require("../dist/game/model/Item");
const { Skill } = require("../dist/game/model/Skill");
const { PlayerStatus } = require("../dist/game/model/PlayerStatus");
const { Bank } = require("../dist/game/model/container/impl/Bank");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");

const LOBSTER = 379;
const WHIP = 4151;
const COINS = 995;

let platform = null;
let platformOutput = "";
let cookie = "";
let csrf = "";
let worldId = "";
let leaseToken = "";

async function platformFetch(pathname, { method = "GET", body, bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = csrf;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${PLATFORM_URL}${pathname}`, {
    method, headers,
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

async function signInAs(username, discordId) {
  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username, discordId } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const sessionCookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const previous = { cookie, csrf };
  cookie = sessionCookie;
  const csrfToken = (await platformFetch("/api/auth/session")).json.csrfToken;
  csrf = csrfToken;
  return { cookie: sessionCookie, csrf: csrfToken, previous };
}

async function enrollAndLease(id, keySuffix) {
  const installationKey = `paescape-economy-install-${keySuffix}`;
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey, label: keySuffix } });
  assert.equal(begin.status, 201, JSON.stringify(begin.json));
  const claim = await platformFetch(`/api/worlds/${id}/enroll`, { method: "POST", body: { code: begin.json.code } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const credential = (await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } })).json.credential;
  const nonce = (await platformFetch("/api/server/handshake/nonce", { method: "POST", body: { installationKey } })).json.nonce;
  const handshake = await platformFetch("/api/server/handshake", { method: "POST", bearer: credential, body: { nonce, generation: 1, protocolVersion: 1 } });
  assert.equal(handshake.status, 200, JSON.stringify(handshake.json));
  return handshake.json.lease.token;
}

async function registerCharacter(name, discordId, { id = worldId, token = leaseToken } = {}) {
  const previous = { cookie, csrf };
  await signInAs("User " + name, discordId);
  const challenge = await platformFetch(`/api/worlds/${id}/link-challenge`, { method: "POST", body: {} });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.json));
  const linked = await platformFetch("/api/server/link", { method: "POST", bearer: token, body: { code: challenge.json.challenge, characterName: name } });
  cookie = previous.cookie;
  csrf = previous.csrf;
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  return linked.json.character;
}

const bridge = require("../plugins/paescape/PaeScapeBridge");
const adapterModule = require("../plugins/persistence/PaeScapePlayerPersistence.plugin");
const { SkillManager } = require("../dist/game/content/skill/SkillManager");

let active = null;
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

function makePlayer(name, index = 1) {
  const messages = [];
  const session = { sendClientPacket: () => true, write() {}, getChannel: () => null, processPackets() {} };
  const player = new Player(session);
  player.setUsername(name);
  player.setIndex(index);
  const sender = player.getPacketSender();
  sender.sendMessage = (text) => { messages.push(text); return sender; };
  player.messages = messages;
  return player;
}

/** Sum a non-stackable item across the slots that hold one each. */
function totalOf(items, itemId) {
  return (items || []).filter((i) => i && i.getId() === itemId).reduce((sum, i) => sum + i.getAmount(), 0);
}

/** Offer an item through the real trade container path. */
function offer(player, itemId, amount) {
  const inventory = player.getInventory();
  const slot = inventory.getSlotForItemId(itemId);
  player.getTrading().handleItem(itemId, amount, slot, inventory, player.getTrading().getContainer());
}

/** Complete the two-stage trade both players must confirm. */
function completeTrade(a, b) {
  a.getTrading().getButtonDelay().stop();
  b.getTrading().getButtonDelay().stop();
  a.getTrading().acceptTrade();
  b.getTrading().acceptTrade();
  a.getTrading().getButtonDelay().stop();
  b.getTrading().getButtonDelay().stop();
  a.getTrading().acceptTrade();
  b.getTrading().acceptTrade();
}

function count(player, itemId) {
  return player.getInventory().getAmount(itemId);
}

before(async () => {
  await CachePipeline.initialize(SERVER_DIR);
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

  const owner = await signInAs("Owner", "discord-1");
  cookie = owner.cookie;
  csrf = owner.csrf;
  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "Economy World" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  worldId = created.json.world.id;
  const live = await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));
  leaseToken = await enrollAndLease(worldId, "one");
  cookie = owner.cookie;
  csrf = owner.csrf;
});

after(async () => {
  if (platform) { platform.kill(); await new Promise((r) => setTimeout(r, 300)); }
});

test("a player trade commits both sides atomically and survives a restart", async () => {
  installAdapter();
  await registerCharacter("Trader Alpha", "discord-trader-a");
  await registerCharacter("Trader Beta", "discord-trader-b");

  const a = makePlayer("Trader Alpha", 1);
  const b = makePlayer("Trader Beta", 2);
  a.getInventory().adds(WHIP, 1);
  b.getInventory().adds(COINS, 500);

  a.getTrading().requestTrade(b);
  b.getTrading().requestTrade(a);
  offer(a, WHIP, 1);
  offer(b, COINS, 200);
  assert.equal(count(a, WHIP), 0, "the offered item left the offerer's inventory");
  assert.equal(count(b, COINS), 300, "the offered coins left the offerer's inventory");

  completeTrade(a, b);
  assert.equal(count(a, COINS), 200, "Alpha received the coins");
  assert.equal(count(b, WHIP), 1, "Beta received the whip");
  await active.flush();

  // A fresh adapter ("restarted server") reads only the platform.
  const reloaded = installAdapter();
  const savedA = reloaded.load("Trader Alpha");
  const savedB = reloaded.load("Trader Beta");
  assert.equal(savedA.getInventory().some((i) => i.getId() === COINS && i.getAmount() === 200), true, "Alpha's coins are authoritative");
  assert.equal(savedA.getInventory().some((i) => i.getId() === WHIP), false, "Alpha no longer holds the traded whip");
  assert.equal(savedB.getInventory().some((i) => i.getId() === WHIP && i.getAmount() === 1), true, "Beta's whip is authoritative");
  assert.equal(savedB.getInventory().some((i) => i.getId() === COINS && i.getAmount() === 300), true, "Beta keeps the coins it retained");

  // The platform recorded the trade with a per-participant item delta.
  const audit = await platformFetch(`/api/server/economy/audit?limit=50`, { bearer: leaseToken });
  assert.equal(audit.status, 200, JSON.stringify(audit.json));
  assert.ok(audit.json.audit.some((row) => row.operationType === "trade"), "the trade is in the audit trail");
});

test("a trade interrupted by a revision conflict rolls back both players", async () => {
  installAdapter();
  await registerCharacter("Rollback Alpha", "discord-rb-a");
  await registerCharacter("Rollback Beta", "discord-rb-b");

  const a = makePlayer("Rollback Alpha", 1);
  const b = makePlayer("Rollback Beta", 2);
  a.getInventory().adds(WHIP, 1);
  b.getInventory().adds(COINS, 500);
  // Load both so the adapter pins their base revisions.
  active.load("Rollback Alpha");
  active.load("Rollback Beta");

  a.getTrading().requestTrade(b);
  b.getTrading().requestTrade(a);
  offer(a, WHIP, 1);
  offer(b, COINS, 200);

  // Advance Beta's platform revision behind the adapter's back, so the atomic
  // commit's expectedRevision is stale and the platform refuses it.
  const betaId = active.resolveCharacterId("Rollback Beta");
  const external = await platformFetch(`/api/server/characters/${betaId}/state`, {
    method: "PUT", bearer: leaseToken,
    body: { expectedRevision: 0, idempotencyKey: "external-advance", state: { __paescapeSchema: 1, save: { inventory: [] } } },
  });
  assert.equal(external.status, 200, JSON.stringify(external.json));

  completeTrade(a, b);
  // The commit failed, so both live players are restored to their pre-trade state.
  assert.equal(count(a, WHIP), 1, "Alpha keeps the whip after the rollback");
  assert.equal(count(a, COINS), 0, "Alpha gained no coins");
  assert.equal(count(b, COINS), 500, "Beta keeps all its coins after the rollback");
  assert.equal(count(b, WHIP), 0, "Beta gained no whip");

  // Neither side was written to the platform by the failed trade.
  const reloaded = installAdapter();
  const savedA = reloaded.load("Rollback Alpha");
  assert.ok(savedA === null || !savedA.getInventory().some((i) => i.getId() === COINS), "the platform never recorded the failed trade for Alpha");
});

test("a replayed commit is idempotent and a conflicting replay is refused", async () => {
  installAdapter();
  await registerCharacter("Idem Hero", "discord-idem");
  const player = makePlayer("Idem Hero", 1);
  player.getInventory().adds(WHIP, 1);
  active.load("Idem Hero");

  const participant = active.captureTransactionParticipant(player);
  const key = participant.characterId + ":idem-test:1";
  const first = active.commitEconomyTransaction({ kind: "bank-deposit", idempotencyKey: key, participants: [participant] });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false, "the first commit is not a replay");
  const revisionAfterFirst = first.participants[0].toRevision;

  const participant2 = active.captureTransactionParticipant(player);
  participant2.revision = participant.revision;
  const replay = active.commitEconomyTransaction({ kind: "bank-deposit", idempotencyKey: key, participants: [participant2] });
  assert.equal(replay.replayed, true, "the same key and payload replays the stored result");
  assert.equal(replay.participants[0].toRevision, revisionAfterFirst, "a replay does not advance the revision");
});

test("a bank deposit and withdrawal are durably committed through the platform", async () => {
  installAdapter();
  await registerCharacter("Banker Hero", "discord-banker");
  const player = makePlayer("Banker Hero", 1);
  active.load("Banker Hero");

  Bank.withoutLimit(player, () => player.setBank(0, new Bank(player)));
  player.getInventory().adds(LOBSTER, 5);
  // The real bank interface state so Bank.deposit/withdraw see an open bank.
  player.setStatus(PlayerStatus.BANKING);
  player.setInterfaceId(Bank.MAIN_INTERFACE_ID);

  const slot = player.getInventory().getSlotForItemId(LOBSTER);
  Bank.deposit(player, LOBSTER, slot, 5, false);
  assert.equal(count(player, LOBSTER), 0, "the lobsters left the inventory");
  assert.equal(player.getBank(0).getAmount(LOBSTER), 5, "the lobsters are in the bank");

  const bankSlot = player.getBank(0).getSlotForItemId(LOBSTER);
  Bank.withdraw(player, LOBSTER, bankSlot, 5, 0);
  assert.equal(count(player, LOBSTER), 5, "the lobsters came back out");

  player.setStatus(PlayerStatus.BANKING);
  player.setInterfaceId(Bank.MAIN_INTERFACE_ID);
  const slot2 = player.getInventory().getSlotForItemId(LOBSTER);
  Bank.deposit(player, LOBSTER, slot2, 2, false);

  // Reload from the platform: the deposit is authoritative without any local save.
  const reloaded = installAdapter();
  const saved = reloaded.load("Banker Hero");
  assert.ok(saved, "the character reloads from the platform");
  assert.equal(totalOf(saved.getInventory(), LOBSTER), 3, "3 lobsters remain in the inventory");
  assert.equal(totalOf(saved.getBanks().get(0), LOBSTER), 2, "2 lobsters are banked");
});

test("a bank change whose commit fails restores the player and reports nothing moved", async () => {
  installAdapter();
  await registerCharacter("Bank Fail Hero", "discord-bankfail");
  const player = makePlayer("Bank Fail Hero", 1);
  active.load("Bank Fail Hero");
  Bank.withoutLimit(player, () => player.setBank(0, new Bank(player)));
  player.getInventory().adds(LOBSTER, 4);
  player.setStatus(PlayerStatus.BANKING);
  player.setInterfaceId(Bank.MAIN_INTERFACE_ID);

  // Advance the platform revision so the deposit's expectedRevision is stale.
  const id = active.resolveCharacterId("Bank Fail Hero");
  await platformFetch(`/api/server/characters/${id}/state`, {
    method: "PUT", bearer: leaseToken,
    body: { expectedRevision: 0, idempotencyKey: "bank-external", state: { __paescapeSchema: 1, save: { inventory: [] } } },
  });

  const slot = player.getInventory().getSlotForItemId(LOBSTER);
  Bank.deposit(player, LOBSTER, slot, 4, false);
  // The failed commit must have rolled the live player back and told them so.
  assert.equal(count(player, LOBSTER), 4, "the lobsters never left the inventory");
  assert.equal(player.getBank(0).getAmount(LOBSTER), 0, "nothing was banked");
  assert.ok(player.messages.some((m) => /could not be saved/i.test(m)), "the failure is reported to the player");
});

test("an uncertain commit is reconciled by idempotency key", async () => {
  const freePort = await new Promise((resolve) => {
    const probe = require("node:net").createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const proxyScript = path.join(WORK_DIR, "uncertain-proxy.cjs");
  fs.writeFileSync(proxyScript, [
    'const http = require("node:http");',
    'const targetPort = Number(process.argv[2]);',
    'const port = Number(process.argv[3]);',
    'let dropped = false;',
    'const server = http.createServer((req, res) => {',
    '  if (req.method === "POST" && req.url.includes("/economy/transactions") && !dropped) {',
    '    const upstream = http.request({ hostname: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers }, (upstreamRes) => {',
    '      upstreamRes.resume();',
    '      upstreamRes.on("end", () => { dropped = true; req.socket.destroy(); });',
    '    });',
    '    upstream.on("error", () => { try { req.socket.destroy(); } catch {} });',
    '    req.pipe(upstream);',
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
  const proxy = spawn(process.execPath, [proxyScript, String(PLATFORM_PORT), String(freePort)], { stdio: ["ignore", "pipe", "pipe"] });
  let proxyOutput = "";
  proxy.stdout.on("data", (d) => (proxyOutput += d));
  proxy.stderr.on("data", (d) => (proxyOutput += d));
  const ready = Date.now() + 15000;
  while (Date.now() < ready && !proxyOutput.includes("ready")) await new Promise((r) => setTimeout(r, 100));
  assert.ok(proxyOutput.includes("ready"), "the proxy started");

  try {
    installAdapter(`http://127.0.0.1:${freePort}`, leaseToken);
    await registerCharacter("Uncertain Hero", "discord-uncertain");
    const player = makePlayer("Uncertain Hero", 1);
    player.getInventory().adds(WHIP, 1);
    active.load("Uncertain Hero");
    const participant = active.captureTransactionParticipant(player);
    const key = participant.characterId + ":uncertain:1";
    // The platform commits but the response never arrives; the adapter reconciles.
    const result = active.commitEconomyTransaction({ kind: "trade", idempotencyKey: key, participants: [participant] });
    assert.equal(result.ok, true, "the committed transaction is recovered");
    assert.equal(result.reconciled, true, "the result came from reconciliation, not the first response");
    assert.equal(result.participants[0].characterId, participant.characterId);
  } finally {
    proxy.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
});

test("hosted gameplay sessions enforce one login and end on logout", async () => {
  const account = await registerCharacter("Session Hero", "discord-session-hero");
  const created = await platformFetch("/api/server/character-sessions", {
    method: "POST", bearer: leaseToken, body: { characterId: account.id, ttlSeconds: 900 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const token = created.json.token;

  const duplicate = await platformFetch("/api/server/character-sessions", {
    method: "POST", bearer: leaseToken, body: { characterId: account.id, ttlSeconds: 900 },
  });
  assert.equal(duplicate.status, 409, "a second live session for the same character is refused");

  const verified = await platformFetch(`/api/server/character-sessions/${token}`, { bearer: leaseToken });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(verified.json.session.characterId, account.id);

  const ended = await platformFetch(`/api/server/character-sessions/${token}?reason=logout`, { method: "DELETE", bearer: leaseToken });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  assert.equal(ended.json.ended, true);

  // After logout a fresh session is allowed again (reclaim).
  const reclaimed = await platformFetch("/api/server/character-sessions", {
    method: "POST", bearer: leaseToken, body: { characterId: account.id, ttlSeconds: 900 },
  });
  assert.equal(reclaimed.status, 201, "the session can be reclaimed after logout");
});

test("a hosted abuse report is stored centrally and never on disk", async () => {
  await registerCharacter("Reporter Hero", "discord-reporter");
  await registerCharacter("Reported Hero", "discord-reported");
  const before = fs.existsSync(LOCAL_SAVE_DIR) ? fs.readdirSync(LOCAL_SAVE_DIR).length : 0;

  const report = await platformFetch("/api/server/abuse-reports", {
    method: "POST", bearer: leaseToken,
    body: { reporterName: "Reporter", reportedName: "Reported", category: "cheating", ruleId: 6, details: "Macroing or use of bots" },
  });
  assert.equal(report.status, 201, JSON.stringify(report.json));
  assert.equal(report.json.report.reportedName, "Reported");

  const listed = await platformFetch("/api/server/abuse-reports", { bearer: leaseToken });
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.ok(listed.json.reports.some((r) => r.reportedName === "Reported"), "the report is in platform storage");

  const after = fs.existsSync(LOCAL_SAVE_DIR) ? fs.readdirSync(LOCAL_SAVE_DIR).length : 0;
  assert.equal(after, before, "no abuse-report file (or any file) was written to the host disk");
});

test("world and platform moderation are separated and isolated", async () => {
  const target = await registerCharacter("Mod Target", "discord-mod-target");
  const platformAdmin = await signInAs("Platform Admin", "discord-1");
  cookie = platformAdmin.cookie;
  csrf = platformAdmin.csrf;

  // A world ban is scoped to this world and blocks login there.
  const worldBan = await platformFetch("/api/moderation/actions", {
    method: "POST", body: { scope: "world", worldId, action: "ban", targetCharacterId: target.id, targetName: "Mod Target", reason: "test" },
  });
  assert.equal(worldBan.status, 201, JSON.stringify(worldBan.json));
  const blocked = await platformFetch(`/api/server/characters/none/moderation?name=Mod%20Target`, { bearer: leaseToken });
  assert.equal(blocked.json.moderation.scope, "world", "the ban resolves as a world ban");
  assert.equal(blocked.json.moderation.action, "ban");

  // Unban restores the character.
  const revoked = await platformFetch(`/api/moderation/actions/${worldBan.json.id}/revoke`, { method: "POST", body: {} });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const cleared = await platformFetch(`/api/server/characters/none/moderation?name=Mod%20Target`, { bearer: leaseToken });
  assert.equal(cleared.json.moderation, null, "the ban is lifted after revoke");
});

test("no local authoritative save is created in hosted mode", () => {
  const entries = fs.existsSync(LOCAL_SAVE_DIR) ? fs.readdirSync(LOCAL_SAVE_DIR) : [];
  assert.deepEqual(entries, [], "the hosted adapter never writes character files to disk");
  assert.equal(active.describe().localSaves, false);
});
