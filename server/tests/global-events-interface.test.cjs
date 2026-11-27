// Run after `yarn build`: node --test tests/global-events-interface.test.cjs
// Paepay/tsps#65 / Paepay/PaeScape_Realms#110: a player starts an event from the ::events
// interface with no inventory item. The world never decides token ownership; it forwards the
// click to the platform, which answers 201 (activated) or 402/409/403 (refused, nothing spent).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, beforeEach, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { setPlatformAccess } = require("../plugins/paescape/PaeScapeBridge");
const Common = require("../plugins/events/global/Common.GlobalEvents");
const Plugin = require("../plugins/events/GlobalEvents.plugin");

const { GROUP_ID, COMPONENT, TAB, TAB_UIDS, ROW_UIDS, uid } = Plugin._test;

let commands;
let buttons;
let calls;
let respond;
let balances;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  Common.testing.setStoreFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-ui-")), "state.json"));
  const core = PluginManager.getCoreApi();
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  const noop = () => {};
  const api = new Proxy({
    core,
    log: noop,
    registerCommand: (name, handler) => { commands[name] = handler; },
    onInterfaceActionButton: (ids, handler) => { buttons.push({ ids: [].concat(ids), handler }); },
  }, { get: (target, key) => (key in target ? target[key] : noop) });
  commands = {};
  buttons = [];
  Plugin.register(api);
});

beforeEach(() => {
  Common.testing.reset();
  calls = [];
  balances = { berserker: 0 };
  respond = defaultResponses;
  setPlatformAccess({
    platformOrigin: () => "https://platform.example",
    platformUserId: (name) => (String(name).toLowerCase() === "clicker" ? "user-1" : null),
    worldRequest: async (route, options = {}) => {
      calls.push({ route, method: options.method ?? "GET", body: options.body ?? null });
      return respond(route, options);
    },
  });
});

afterEach(() => {
  setPlatformAccess(null);
});

function tokenRows() {
  return Common.catalog().map((event) => ({ eventId: event.id, quantity: balances[event.id] ?? 0 }));
}

function defaultResponses(route, options) {
  const method = options.method ?? "GET";
  if (route.startsWith("/events/account")) {
    return { ok: true, status: 200, json: { account: { userId: "user-1", paepointsBalance: 900, tokens: tokenRows(), disabledEventIds: [] } } };
  }
  if (route.startsWith("/events/tokens")) {
    return { ok: true, status: 200, json: { userId: "user-1", paepointsBalance: 900, tokens: tokenRows() } };
  }
  if (route === "/events" && method === "GET") {
    return { ok: true, status: 200, json: { events: { combat: null, skilling: null, utility: null } } };
  }
  if (route === "/events/activate" && method === "POST") {
    const eventId = options.body.eventId;
    if ((balances[eventId] ?? 0) < 1) {
      return { ok: false, status: 402, json: { error: "You do not have a token for that event." } };
    }
    balances[eventId] -= 1;
    const event = Common.definition(eventId);
    const startsAt = new Date(Date.now() - 1000).toISOString();
    const endsAt = new Date(Date.now() + 90 * 60_000).toISOString();
    const activation = {
      category: event.category,
      eventId,
      name: event.name,
      summary: event.summary,
      description: event.description,
      effect: event.effect,
      startsAt,
      endsAt,
      activationId: `activation-${eventId}`,
      activator: { userId: "user-1", displayName: "Clicker" },
    };
    const events = { combat: null, skilling: null, utility: null };
    events[event.category] = activation;
    return { ok: true, status: 201, json: { ok: true, replayed: false, activation, tokenBalance: balances[eventId], events } };
  }
  return { ok: true, status: 200, json: {} };
}

function player(name = "clicker") {
  const strings = new Map();
  let interfaceId = -1;
  const messages = [];
  return {
    messages,
    strings,
    attributes: new Map(),
    getUsername: () => name,
    sendMessage: (message) => messages.push(message),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
    getInterfaceId: () => interfaceId,
    setInterfaceId: (id) => { interfaceId = id; },
    getPacketSender: () => ({
      sendString: (text, component) => strings.set(component, text),
      sendSubInterface() {},
    }),
  };
}

const handlerFor = (id) => buttons.find((entry) => entry.ids.includes(id)).handler;
const rowsOf = (p) => JSON.parse(p.strings.get(uid(COMPONENT.DATA)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function rowId(eventId) {
  return Common.catalog().findIndex((event) => event.id === eventId) + 1;
}

async function openAndSelect(p, eventId, tab = TAB.TOKENS) {
  commands.events({ player: p, parts: ["events"] });
  await settle();
  handlerFor(TAB_UIDS[["active", "claimable", "tokens"].indexOf(tab)])({ player: p, buttonId: TAB_UIDS[["active", "claimable", "tokens"].indexOf(tab)] });
  handlerFor(ROW_UIDS[0])({ player: p, slot: rowId(eventId) });
}

const pressActivate = (p) => handlerFor(uid(COMPONENT.ACTIVATE_BUTTON))({ player: p });

test("::events opens the Events interface and lists every event without any inventory item", async () => {
  balances.berserker = 2;
  const p = player();
  commands.events({ player: p, parts: ["events"] });
  await settle();
  assert.equal(p.getInterfaceId(), GROUP_ID);
  const rows = rowsOf(p);
  assert.equal(rows.filter((row) => row.eventId).length, 15);
  const layout = JSON.parse(p.strings.get(uid(COMPONENT.LAYOUT)));
  assert.equal(layout.tabs[2].length, 15, "the Tokens tab lists every event, owned or not");
  const berserker = rows.find((row) => row.eventId === "berserker");
  assert.match(berserker.detail, /2 tokens/);
  assert.match(berserker.panel.info2, /Select Activate to spend one token/);
});

test("an event with no token explains the Store and activating it is refused by the platform", async () => {
  const p = player();
  await openAndSelect(p, "berserker");
  const idle = rowsOf(p).find((row) => row.eventId === "berserker");
  assert.match(idle.panel.info2, /buy one with PaePoints in the website Store/);
  calls.length = 0;
  pressActivate(p);
  await settle();
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1, "the world forwards the click; it does not pre-judge ownership");
  assert.equal(posts[0].route, "/events/activate");
  assert.equal(posts[0].body.userId, "user-1");
  assert.equal(posts[0].body.eventId, "berserker");
  assert.equal(Common.active("combat"), null, "a 402 activates nothing");
  assert.match(p.messages.join("\n"), /don't have a Berserker token.*PaePoints in the Store/);
});

test("pressing Activate with a token starts the event and refreshes the interface", async () => {
  balances.berserker = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  await settle();
  assert.equal(Common.active("combat").eventId, "berserker");
  assert.match(p.messages.join("\n"), /Berserker activated for 90 minutes\. One event token was spent\./);
  const row = rowsOf(p).find((entry) => row_is(entry, "berserker"));
  assert.match(row.detail, /on, 1h 29m|on, 1h 30m/, "the list now shows the running event");
  assert.equal(balances.berserker, 0, "exactly one token was spent by the platform");
  const layout = JSON.parse(p.strings.get(uid(COMPONENT.LAYOUT)));
  assert.deepEqual(layout.tabs[0], [rowId("berserker")], "the event now appears on the Active tab");
});

function row_is(row, eventId) {
  return row.eventId === eventId;
}

test("the category slot stays one-at-a-time: a second combat event is refused by the platform", async () => {
  balances.berserker = 1;
  balances.deadeye = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  respond = (route, options) => (route === "/events/activate"
    ? { ok: false, status: 409, json: { error: "combat already has Berserker active on this world." } }
    : defaultResponses(route, options));
  handlerFor(ROW_UIDS[0])({ player: p, slot: rowId("deadeye") });
  pressActivate(p);
  await settle();
  assert.equal(Common.active("combat").eventId, "berserker");
  assert.match(p.messages.join("\n"), /category already has an event running/);
  assert.equal(balances.deadeye, 1, "the refused activation spent nothing");
});

test("Activate with nothing selected, or a claimable item selected, makes no platform request", async () => {
  const p = player();
  commands.events({ player: p, parts: ["events"] });
  await settle();
  calls.length = 0;
  pressActivate(p);
  assert.match(p.messages.join("\n"), /Select an event first/);
  p.setAttribute(Plugin._test.SELECTED_ATTRIBUTE, `${TAB.CLAIMABLE}:100`);
  pressActivate(p);
  await settle();
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("an unlinked character cannot activate from the interface and no request is made", async () => {
  const p = player("stranger");
  await openAndSelect(p, "berserker");
  calls.length = 0;
  pressActivate(p);
  await settle();
  assert.equal(calls.filter((call) => call.route === "/events/activate").length, 0);
  assert.match(p.messages.join("\n"), /not linked to a PaeScape account/);
});
