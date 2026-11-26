// Run from server/: yarn build && node --test tests/paescape-discord-item.test.cjs
//
// Issue #206: the platform-signed world route that banks an item for a Discord
// Developer's `/item` delivery. It must deliver a real item to an online player,
// report a full bank clearly, and refuse unknown players, items and tokens.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { _test } = require("../plugins/paescape/PaeScape.plugin");
const { GameConstants } = require("../dist/game/GameConstants");

const WORLD_ID = "wld_official_paescape";
const CONTROL = "/api/platform";
const WHIP = 4151;
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

class Item {
  constructor(id, amount) { this.id = id; this.amount = amount; }
  getId() { return this.id; }
  getAmount() { return this.amount; }
}

const Bank = {
  CONTAINER_START: 50300,
  getTabForItem: () => 0,
};

const ItemDefinition = {
  forId: (id) => id === WHIP
    ? { getId: () => WHIP, getName: () => "Abyssal whip" }
    : { getId: () => 0, getName: () => "" },
};

function fakeBank(room) {
  return {
    added: [],
    getAddableAmount: (item) => Math.min(item.getAmount(), room),
    add(item, refresh) { this.added.push({ id: item.getId(), amount: item.getAmount(), refresh }); },
  };
}

function fakePlayer(name, room = 1) {
  const bank = fakeBank(room);
  return {
    bank,
    getUsername: () => name,
    getDisplayName: () => name,
    isPlayerBot: () => false,
    getBank: () => bank,
  };
}

let saves;
let players;
let api;

function configure(list, room = 1) {
  players = list.map((name) => fakePlayer(name, room));
  const byName = new Map(players.map((player) => [player.getUsername().toLowerCase(), player]));
  saves = [];
  api = {
    core: {
      World: { getPlayerByName: (name) => byName.get(String(name ?? "").toLowerCase()) ?? null },
      Bank,
      Item,
      ItemDefinition,
    },
  };
  const previous = GameConstants.PLAYER_PERSISTENCE;
  GameConstants.PLAYER_PERSISTENCE = { requestSave: (player, reason) => saves.push({ player, reason }) };
  _test.configureControlForTests({ publicKey, worldId: WORLD_ID, worldSecret: "", api });
  return () => { GameConstants.PLAYER_PERSISTENCE = previous; };
}

function controlRequest({ path = `${CONTROL}/discord/item`, action = "world:discord-item", authorization, body } = {}) {
  const header = authorization === undefined ? token(action) : authorization;
  return {
    method: "POST",
    path,
    headers: header === null ? {} : { authorization: header },
    body: body === undefined ? JSON.stringify({}) : JSON.stringify(body),
  };
}

test("delivers the item to the online player's bank and requests a save", async () => {
  const restore = configure(["Alice"]);
  try {
    const result = await _test.handleControl(controlRequest({ body: { username: "alice", itemId: WHIP, quantity: 1 } }));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.itemName, "Abyssal whip");
    assert.equal(result.body.worldId, WORLD_ID);
    assert.deepEqual(players[0].bank.added, [{ id: WHIP, amount: 1, refresh: true }]);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].player, players[0]);
    assert.equal(saves[0].reason, "discord-item");
  } finally {
    restore();
  }
});

test("reports a full bank clearly and delivers nothing", async () => {
  const restore = configure(["Alice"], 0);
  try {
    const result = await _test.handleControl(controlRequest({ body: { username: "Alice", itemId: WHIP, quantity: 1 } }));
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.bankFull, true);
    assert.match(result.body.error, /Alice's bank is full/);
    assert.deepEqual(players[0].bank.added, []);
    assert.equal(saves.length, 0);
  } finally {
    restore();
  }
});

test("a partial fit is refused rather than delivering part of the stack", async () => {
  const restore = configure(["Alice"], 1);
  try {
    const result = await _test.handleControl(controlRequest({ body: { username: "Alice", itemId: WHIP, quantity: 5 } }));
    assert.equal(result.status, 409);
    assert.equal(result.body.bankFull, true);
    assert.deepEqual(players[0].bank.added, []);
  } finally {
    restore();
  }
});

test("refuses an offline player, an unknown item, a bad quantity and a wrong token", async () => {
  const restore = configure(["Alice"]);
  try {
    const offline = await _test.handleControl(controlRequest({ body: { username: "Bob", itemId: WHIP, quantity: 1 } }));
    assert.deepEqual([offline.status, /not online/.test(offline.body.error)], [404, true]);

    const unknownItem = await _test.handleControl(controlRequest({ body: { username: "Alice", itemId: 999999, quantity: 1 } }));
    assert.deepEqual([unknownItem.status, /does not exist/.test(unknownItem.body.error)], [404, true]);

    const badQuantity = await _test.handleControl(controlRequest({ body: { username: "Alice", itemId: WHIP, quantity: 0 } }));
    assert.equal(badQuantity.status, 400);

    const wrongToken = await _test.handleControl(controlRequest({
      authorization: token("world:staff-command"),
      body: { username: "Alice", itemId: WHIP, quantity: 1 },
    }));
    assert.equal(wrongToken.status, 401);
    assert.deepEqual(players[0].bank.added, []);
  } finally {
    restore();
  }
});
