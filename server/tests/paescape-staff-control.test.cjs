// Run from server/: yarn build && node --test tests/paescape-staff-control.test.cjs
//
// Issue #80 / PaeScape_Realms#80: the signed staff control boundary,
// world-side hierarchy, rank sync and hosted command floors.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test, beforeEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { _test } = require("../plugins/paescape/PaeScape.plugin");
const { Accounts } = require("../dist/game/entity/impl/player/Accounts");
const { GameConstants } = require("../dist/game/GameConstants");
const { PlayerRights } = require("../dist/game/model/rights/PlayerRights");
const { PluginManager } = require("../dist/plugins/PluginManager");

const WORLD_ID = "wld_official_paescape";
const CONTROL = "/api/platform";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

function token(action, overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    worldId: WORLD_ID,
    action,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  })).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return `Bearer ${payload}.${signature}`;
}

function fakePlayer(name, rights = 0) {
  const player = {
    name,
    username: name,
    rights,
    messages: [],
    loggedOut: 0,
    getUsername() { return this.username; },
    getRights() { return { getId: () => this.rights }; },
    setRights(value) { this.rights = typeof value === "number" ? value : value.getId(); },
    getSkillManager() { return { getCombatLevel: () => 42, getTotalLevel: () => 321 }; },
    sendMessage(text) { this.messages.push(text); },
    requestLogout() { this.loggedOut += 1; },
    isPlayerBot() { return false; },
  };
  return player;
}

function fakePunishment() {
  const bans = new Set();
  const mutes = new Set();
  const state = { flushes: 0 };
  return {
    state,
    bans,
    mutes,
    banned: (key) => bans.has(key),
    muted: (key) => mutes.has(key),
    ban: (key) => bans.add(key),
    unban: (key) => bans.delete(key),
    mute: (key) => mutes.add(key),
    unmute: (key) => mutes.delete(key),
    flush: async () => { state.flushes += 1; },
  };
}

function fakePersistence(names = []) {
  const existing = new Set(names.map((name) => Accounts.key(name)));
  return {
    exists: (name) => existing.has(Accounts.key(name)),
  };
}

let players;
let punishment;
let persistence;
let controller;
let api;

function configure(options = {}) {
  players = options.players ?? [fakePlayer("Alice", PlayerRights.NONE.getId()), fakePlayer("Bob", PlayerRights.NONE.getId())];
  const byName = new Map(players.map((player) => [player.getUsername().toLowerCase(), player]));
  punishment = options.punishment === undefined ? fakePunishment() : options.punishment;
  persistence = options.persistence === undefined ? fakePersistence(["OfflineGuy"]) : options.persistence;
  api = {
    core: {
      World: {
        getPlayers: () => players,
        getPlayerByName: (name) => byName.get(String(name ?? "").toLowerCase()) ?? null,
      },
    },
    getPlayerPunishment: () => punishment,
  };
  _test.configureControlForTests({ publicKey, worldId: WORLD_ID, worldSecret: "", api });
  controller = _test.configureStaffForTests({
    api,
    hosted: true,
    userAccounts: options.userAccounts ?? {},
    getPunishment: () => punishment,
    getPersistence: () => persistence,
  });
}

function controlRequest({ method = "POST", path = `${CONTROL}/staff/command`, action = "world:staff-command", authorization, body } = {}) {
  const header = authorization === undefined ? token(action) : authorization;
  return {
    method,
    path,
    headers: header === null ? {} : { authorization: header },
    body: body === undefined ? JSON.stringify({}) : JSON.stringify(body),
  };
}

beforeEach(() => configure());

test("forged, expired, wrong-action and wrong-world staff control tokens are refused", async () => {
  const forgedPayload = Buffer.from(JSON.stringify({
    worldId: WORLD_ID,
    action: "world:staff-command",
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString("base64url");
  const body = { action: "ban", actorRole: "admin", targetRole: "player", target: { name: "Bob" }, reason: "test" };
  const cases = [
    { name: "missing", authorization: null },
    { name: "forged", authorization: `Bearer ${forgedPayload}.${Buffer.from("not a signature").toString("base64")}` },
    { name: "expired", authorization: token("world:staff-command", { exp: Math.floor(Date.now() / 1000) - 1 }) },
    { name: "wrong action", authorization: token("world:staff-lookup") },
    { name: "wrong world", authorization: token("world:staff-command", { worldId: "wld_someone_else" }) },
  ];
  for (const testCase of cases) {
    const result = await _test.handleControl(controlRequest({ authorization: testCase.authorization, body }));
    assert.equal(result.status, 401, `${testCase.name} token must be refused`);
  }
  assert.equal(players[1].loggedOut, 0);
  assert.equal(punishment.bans.size, 0);
});

test("a signed lookup returns online players and the offline platform record id", async () => {
  configure({ userAccounts: { user_offline: Accounts.key("OfflineGuy") } });
  const online = await _test.handleControl(controlRequest({
    method: "GET",
    path: `${CONTROL}/staff/lookup?q=ali`,
    action: "world:staff-lookup",
    authorization: token("world:staff-lookup"),
  }));
  assert.equal(online.status, 200);
  assert.equal(online.body.players[0].name, "Alice");
  assert.equal(online.body.players[0].online, true);
  assert.equal(online.body.players[0].combat, 42);

  const offline = await _test.handleControl(controlRequest({
    method: "GET",
    path: `${CONTROL}/staff/lookup?q=offlineguy`,
    action: "world:staff-lookup",
    authorization: token("world:staff-lookup"),
  }));
  assert.equal(offline.status, 200);
  assert.equal(offline.body.players[0].online, false);
  assert.equal(offline.body.players[0].userId, "user_offline");
});

test("an empty signed lookup returns the sorted live player preview", async () => {
  const preview = await _test.handleControl(controlRequest({
    method: "GET",
    path: `${CONTROL}/staff/lookup?q=`,
    action: "world:staff-lookup",
    authorization: token("world:staff-lookup"),
  }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview, true);
  assert.deepEqual(preview.body.players.map((player) => player.name), ["Alice", "Bob"]);
  assert.equal(preview.body.players.every((player) => player.online === true), true);
});

test("mute, unmute, ban, unban and kick use the real punishment and logout paths", async () => {
  const bob = players[1];
  const bobKey = Accounts.key("Bob");
  const base = { actorUserId: "user_actor", targetRole: "player", target: { name: "Bob", userId: "user_bob" }, reason: "staff test" };

  const muted = await controller.command({ ...base, action: "mute", actorRole: "moderator" });
  assert.equal(muted.status, 200);
  assert.equal(punishment.mutes.has(bobKey), true);
  assert.equal(bob.messages.at(-1), "You have been muted by PaeScape staff.");

  const unmuted = await controller.command({ ...base, action: "unmute", actorRole: "moderator" });
  assert.equal(unmuted.status, 200);
  assert.equal(punishment.mutes.has(bobKey), false);
  assert.equal(bob.messages.at(-1), "You have been unmuted.");

  const banned = await controller.command({ ...base, action: "ban", actorRole: "admin" });
  assert.equal(banned.status, 200);
  assert.equal(punishment.bans.has(bobKey), true);
  assert.equal(bob.loggedOut, 1);

  const unbanned = await controller.command({ ...base, action: "unban", actorRole: "admin" });
  assert.equal(unbanned.status, 200);
  assert.equal(punishment.bans.has(bobKey), false);

  const kicked = await controller.command({ ...base, action: "kick", actorRole: "moderator" });
  assert.equal(kicked.status, 200);
  assert.equal(bob.loggedOut, 2);
  assert.ok(punishment.state.flushes >= 2, "punishment changes are flushed");
});

test("rank sync applies immediately online and from the pending rank on next login", () => {
  const online = players[0];
  const result = controller.syncRank({
    userId: "user_online",
    role: "moderator",
    characterNames: ["Alice", "OfflineGuy"],
  });
  assert.equal(result.status, 200);
  assert.equal(online.paeScapeStaff.role, "moderator");
  assert.equal(online.paeScapeStaff.userId, "user_online");
  assert.equal(online.getRights().getId(), PlayerRights.MODERATOR.getId());
  assert.deepEqual(result.body.updated, ["Alice"]);

  const offline = fakePlayer("OfflineGuy");
  controller.onLogin(offline);
  assert.equal(offline.paeScapeStaff.role, "moderator");
  assert.equal(offline.getRights().getId(), PlayerRights.MODERATOR.getId());

  controller.syncRank({ userId: "user_online", role: "player", characterNames: ["Alice", "OfflineGuy"] });
  assert.equal(online.paeScapeStaff, undefined);
  assert.equal(online.getRights().getId(), PlayerRights.NONE.getId());
  const offlineAfter = fakePlayer("OfflineGuy");
  controller.onLogin(offlineAfter);
  assert.equal(offlineAfter.paeScapeStaff, undefined);
  assert.equal(offlineAfter.getRights().getId(), PlayerRights.NONE.getId());
});

test("self, equal, higher, Host and Developer targets are refused", async () => {
  const body = {
    action: "mute",
    actorUserId: "user_actor",
    actorRole: "moderator",
    targetRole: "player",
    target: { name: "Bob", userId: "user_actor" },
  };
  const self = await controller.command(body);
  assert.equal(self.status, 403);
  assert.match(self.body.error, /yourself/i);

  const equal = await controller.command({ ...body, target: { name: "Bob", userId: "user_bob" }, targetRole: "moderator" });
  assert.equal(equal.status, 403);
  assert.match(equal.body.error, /equal or higher/i);

  const higher = await controller.command({ ...body, target: { name: "Bob", userId: "user_bob" }, actorRole: "moderator", targetRole: "admin" });
  assert.equal(higher.status, 403);

  const developer = await controller.command({ ...body, target: { name: "Bob", userId: "user_bob" }, actorRole: "developer", targetRole: "developer" });
  assert.equal(developer.status, 403);

  const host = await controller.command({ ...body, target: { name: "Bob", userId: "user_bob" }, actorRole: "developer", targetRole: "host" });
  assert.equal(host.status, 403);
  assert.match(host.body.error, /Host cannot be targeted/i);
});

test("offline and unavailable worlds/commands fail without pretending success", async () => {
  const offlineKick = await controller.command({
    action: "kick",
    actorUserId: "user_actor",
    actorRole: "moderator",
    targetRole: "player",
    target: { name: "OfflineGuy", userId: "user_offline" },
  });
  assert.equal(offlineKick.status, 409);
  assert.match(offlineKick.body.error, /offline/i);

  const missingRecord = await controller.command({
    action: "ban",
    actorUserId: "user_actor",
    actorRole: "admin",
    targetRole: "player",
    target: { name: "NotHere", userId: "user_missing" },
  });
  assert.equal(missingRecord.status, 404);

  configure({ punishment: null, players: [fakePlayer("Alice"), fakePlayer("Bob")] });
  const noStorage = await controller.command({
    action: "mute",
    actorUserId: "user_actor",
    actorRole: "moderator",
    targetRole: "player",
    target: { name: "Bob", userId: "user_bob" },
  });
  assert.equal(noStorage.status, 503);
});

test("hosted command floors allow open and explicitly granted commands only", () => {
  PluginManager.setCommandRights("staffflooropen", PlayerRights.NONE);
  PluginManager.setCommandRights("stafffloorrestricted", PlayerRights.MODERATOR);
  const moderator = {
    getRights: () => PlayerRights.MODERATOR,
    paeScapeStaff: { role: "moderator", commands: new Set(["mute"]) },
  };
  assert.equal(PluginManager.playerHasCommandRights(moderator, "staffflooropen"), true);
  assert.equal(PluginManager.playerHasCommandRights(moderator, "mute"), true);
  assert.equal(PluginManager.playerHasCommandRights(moderator, "stafffloorrestricted"), false, "a default-Moderator command does not leak in");
  assert.equal(PluginManager.playerHasCommandRights(moderator, "stafffloorunregistered"), false, "an undefined floor is not broadly opened");

  const developer = { getRights: () => PlayerRights.DEVELOPER, paeScapeStaff: { role: "developer", commands: null } };
  assert.equal(PluginManager.playerHasCommandRights(developer, "stafffloorrestricted"), true);
  assert.equal(PluginManager.playerHasCommandRights(developer, "stafffloorunregistered"), true);
});

test("the world refuses a hosted punitive command when platform authorization is unavailable", async () => {
  const { CachePipeline } = require("../dist/game/cache/CachePipeline");
  const path = require("node:path");
  const { Player } = require("../dist/game/entity/impl/player/Player");
  const { CommandPacketListener } = require("../dist/net/packet/impl/CommandPacketListener");
  const AdminCommands = require("../plugins/commands/AdminCommands.plugin");
  const bridge = require("../plugins/paescape/PaeScapeBridge");

  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const core = PluginManager.getCoreApi();
  const online = [];
  core.World.players = { search: (match) => online.find(match) ?? null, forEach: (each) => online.forEach(each) };
  AdminCommands.register(PluginManager.createApi("StaffFloorTest"));

  const staff = new Player(null);
  staff.setUsername("StaffCheck");
  staff.setRights(PlayerRights.MODERATOR);
  staff.paeScapeStaff = { role: "moderator", commands: new Set(["mute", "kick"]) };
  const messages = [];
  staff.sendMessage = (text) => messages.push(text);
  staff.getPacketSender = () => new Proxy({}, { get: () => () => staff.getPacketSender() });
  online.push(staff);

  bridge.setPlatformAccess(null);
  CommandPacketListener.execute(staff, "mute ZedStaff9");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(messages.at(-1), /authorization check is unavailable/i);

  bridge.setPlatformAccess({
    authorizeStaffCommand: async () => ({ allowed: false, reason: "Platform refused test" }),
  });
  CommandPacketListener.execute(staff, "mute ZedStaff9");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.at(-1), "Platform refused test");
  bridge.setPlatformAccess(null);
});
