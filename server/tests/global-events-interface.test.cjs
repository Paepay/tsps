// Run after `yarn build`: node --test tests/global-events-interface.test.cjs
// Paepay/tsps#65 / Paepay/PaeScape_Realms#110: the ::events interface (Live / Activate / Claimable
// tabs, the website countdown and symbols, a personal on/off switch, announcements). A player
// starts an event from the ::events
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
const Layout = require("../plugins/events/global/Interface.GlobalEvents");
const { _test: Sprites } = require("../plugins/world/CustomSprites.plugin");

const { GROUP_ID, COMPONENT, TAB, SPRITE, SLOT_ROW_START, TAB_UIDS, ROW_UIDS, uid } = Plugin._test;

let commands;
let commandRights;
let customEvents;
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
    registerCommand: (name, handler, rights) => { commands[name] = handler; commandRights[name] = rights; },
    onCustomEvent: (name, handler) => { customEvents[name] = handler; },
    onInterfaceActionButton: (ids, handler) => { buttons.push({ ids: [].concat(ids), handler }); },
  }, { get: (target, key) => (key in target ? target[key] : noop) });
  commands = {};
  commandRights = {};
  customEvents = {};
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
  const sends = [];
  let interfaceId = -1;
  const messages = [];
  return {
    messages,
    strings,
    sends,
    attributes: new Map(),
    getUsername: () => name,
    sendMessage: (message) => messages.push(message),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
    getInterfaceId: () => interfaceId,
    setInterfaceId: (id) => { interfaceId = id; },
    getPacketSender: () => ({
      sendString: (text, component) => { strings.set(component, text); sends.push(component); },
      sendSubInterface() {},
    }),
  };
}

const handlerFor = (id) => buttons.find((entry) => entry.ids.includes(id)).handler;
const rowsOf = (p) => JSON.parse(p.strings.get(uid(COMPONENT.DATA)));
const layoutOf = (p) => JSON.parse(p.strings.get(uid(COMPONENT.LAYOUT)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const TAB_INDEX = { [TAB.LIVE]: 0, [TAB.ACTIVATE]: 1, [TAB.CLAIMABLE]: 2 };

function rowId(eventId) {
  return Common.catalog().findIndex((event) => event.id === eventId) + 1;
}

const rowFor = (p, eventId) => rowsOf(p).find((row) => row.eventId === eventId);

function clickTab(p, tab) {
  const id = TAB_UIDS[TAB_INDEX[tab]];
  handlerFor(id)({ player: p, buttonId: id });
}

const clickRow = (p, id) => handlerFor(ROW_UIDS[0])({ player: p, slot: id });

async function openAndSelect(p, eventId, tab = TAB.ACTIVATE) {
  commands.events({ player: p, parts: ["events"] });
  await settle();
  clickTab(p, tab);
  clickRow(p, rowId(eventId));
}

const pressActivate = (p) => handlerFor(uid(COMPONENT.ACTIVATE_BUTTON))({ player: p });
const pressToggle = (p) => handlerFor(uid(COMPONENT.TOGGLE_BUTTON))({ player: p });

/** Run `body` with Date.now fixed, so a countdown only moves when the test moves the clock. */
async function withClock(body) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    await body({ advance: (ms) => { now += ms; }, now: () => now });
  } finally {
    Date.now = real;
  }
}

/** Make `players` the world's population for announcements. */
async function withWorldPlayers(players, body) {
  const World = PluginManager.getCoreApi().World;
  const original = World.getPlayers;
  World.getPlayers = () => players;
  try {
    await body();
  } finally {
    World.getPlayers = original;
  }
}

function platformActivation(eventId, { startedAgoMs = 1000, minutes = 90, endsInMs, id = `activation-${eventId}`, by = "Clicker" } = {}) {
  const event = Common.definition(eventId);
  const startedAt = Date.now() - startedAgoMs;
  return {
    category: event.category,
    eventId,
    name: event.name,
    summary: event.summary,
    description: event.description,
    effect: event.effect,
    startsAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsInMs === undefined ? startedAt + minutes * 60_000 : Date.now() + endsInMs).toISOString(),
    activationId: id,
    activator: { userId: "user-1", displayName: by },
  };
}

test("the Events interface and the globalevent admin command are Developer-only in game", async () => {
  const developer = PluginManager.getCoreApi().PlayerRights.DEVELOPER;
  assert.equal(commandRights.events.getId(), developer.getId(), "::events needs Developer rights");
  assert.equal(commandRights.globalevent.getId(), developer.getId(), "::globalevent needs Developer rights");
});

test("a player without Developer rights cannot open Events by any route and is told so", async () => {
  const Manager = PluginManager;
  const original = Manager.playerHasCommandRights;
  Manager.playerHasCommandRights = (_player, base) => (base === "events" ? false : original.call(Manager, _player, base));
  try {
    const typed = player();
    commands.events({ player: typed, parts: ["events"] });
    await settle();
    assert.notEqual(typed.getInterfaceId(), GROUP_ID, "the typed command does not open the interface");
    assert.match(typed.messages.join(" "), /do not have permission/);

    // The HUD icon's route is the custom event, which skips the command gate.
    const icon = player();
    customEvents["global-events:open"]({ player: icon });
    await settle();
    assert.notEqual(icon.getInterfaceId(), GROUP_ID, "the HUD route does not open the interface either");
    assert.match(icon.messages.join(" "), /do not have permission/);
    assert.equal(calls.length, 0, "a refused player causes no platform request");
    assert.equal(Common.statePayload(icon).canOpen, false, "the client is told to hide the button");
  } finally {
    Manager.playerHasCommandRights = original;
  }
  // A developer still gets the button and the interface.
  const dev = player();
  assert.equal(Common.statePayload(dev).canOpen, true);
  customEvents["global-events:open"]({ player: dev });
  await settle();
  assert.equal(dev.getInterfaceId(), GROUP_ID);
});

test("the interface has Live, Activate and Claimable tabs, one wide action button and no visible buttons before a selection", () => {
  const built = Layout.buildInterface();
  assert.deepEqual(built.tabs.labels, ["Live", "Activate", "Claimable"]);
  const button = (component) => built.widgets.find((entry) => entry.fileId === component);
  const hiddenAtStart = [
    COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL, COMPONENT.CLAIM_BUTTON,
    COMPONENT.CLAIM_LABEL, COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL,
  ].map(button);
  assert.ok(hiddenAtStart.every((entry) => entry && (entry.hidden === true || entry.isHidden === true)), "no action is offered until a row is selected");
  const select = built.list.select;
  assert.equal(select.texts.toggle, COMPONENT.TOGGLE_LABEL, "the server writes the Disable/Enable caption");
  assert.equal(select.texts.activate, COMPONENT.ACTIVATE_LABEL);
  assert.equal(built.tabs.labels.length, TAB_UIDS.length);
});

test("::events opens on the Live tab with a row for every category slot and the first one selected", async () => {
  const p = player();
  commands.events({ player: p, parts: ["events"] });
  await settle();
  assert.equal(p.getInterfaceId(), GROUP_ID);
  const layout = layoutOf(p);
  assert.equal(layout.active, 0, "the player lands on Live");
  assert.deepEqual(layout.tabs[0], [SLOT_ROW_START, SLOT_ROW_START + 1, SLOT_ROW_START + 2], "all three slots are listed, empty or not");
  assert.equal(layout.selected, SLOT_ROW_START, "the panel is never left blank");
  const combat = rowsOf(p).find((row) => row.id === SLOT_ROW_START);
  assert.equal(combat.name, "Combat slot");
  assert.match(combat.detail, /empty/);
  assert.match(combat.panel.info, /No combat event is live/);
  assert.deepEqual(combat.show, [], "an empty slot offers no action");
  assert.equal(combat.sprite, SPRITE.ROW.combat, "the row wears the website's Combat symbol");
  assert.equal(combat.panelSprite, SPRITE.PANEL.combat);
});

test("the Activate tab lists every event under Combat, Skilling and Utility with the website symbols and token counts", async () => {
  balances.berserker = 2;
  const p = player();
  commands.events({ player: p, parts: ["events"] });
  await settle();
  clickTab(p, TAB.ACTIVATE);
  const rows = rowsOf(p);
  const events = rows.filter((row) => row.eventId);
  assert.equal(events.length, 15);
  const headers = layoutOf(p).tabs[1].filter((entry) => typeof entry !== "number");
  assert.deepEqual(headers, [{ header: "Combat" }, { header: "Skilling" }, { header: "Utility" }]);
  assert.equal(layoutOf(p).tabs[1].filter((entry) => typeof entry === "number").length, 15, "every event is listed, owned or not");
  for (const row of events) {
    assert.equal(row.sprite, SPRITE.ROW[row.category], `${row.eventId} uses its category's website symbol`);
    assert.equal(row.panelSprite, SPRITE.PANEL[row.category]);
    assert.equal(row.icon, undefined, "no item icon stands in for the symbol");
  }
  assert.match(rowFor(p, "berserker").detail, /2 tokens/);
  assert.equal(layoutOf(p).selected, rowId(Common.catalog()[0].id), "the first event is selected on arrival");
  assert.deepEqual(rowFor(p, "berserker").show, Plugin._test.SHOW.ACTIVATE);
});

test("an event with no token says so and activating it is refused by the platform", async () => {
  const p = player();
  await openAndSelect(p, "berserker");
  const idle = rowFor(p, "berserker");
  assert.equal(idle.panel.info, "Your tokens: 0");
  assert.equal(idle.panel.activate, "Activate (no tokens)");
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

test("event tokens belong to the Discord account: the panel says so and the request carries the account, not a world", async () => {
  balances.berserker = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  const idle = rowFor(p, "berserker");
  assert.equal(idle.panel.activate, "Activate (uses 1 token)");
  assert.match(idle.panel.description, /belong to your Discord account and work on any world/);
  assert.match(idle.panel.description, /uses up one token for good/);
  calls.length = 0;
  pressActivate(p);
  await settle();
  const activation = calls.find((call) => call.route === "/events/activate");
  assert.deepEqual(Object.keys(activation.body).sort(), ["eventId", "idempotencyKey", "userId"], "only the account and the event are sent");
  assert.equal(activation.body.userId, "user-1");
});

test("pressing Activate with a token starts the event, spends exactly one and shows its live countdown", async () => {
  balances.berserker = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  await settle();
  assert.equal(Common.active("combat").eventId, "berserker");
  assert.match(p.messages.join("\n"), /Berserker activated for 90 minutes\. One event token was spent\./);
  const row = rowFor(p, "berserker");
  assert.match(row.detail, /^ - Live 1h (29|30)m$/, "the list shows the running event with the website's countdown format");
  assert.equal(balances.berserker, 0, "exactly one token was spent by the platform");
  assert.deepEqual(layoutOf(p).tabs[0], [rowId("berserker"), SLOT_ROW_START + 1, SLOT_ROW_START + 2], "the Live tab now lists it in the combat slot");
  assert.deepEqual(row.show, Plugin._test.SHOW.TOGGLE, "a running event offers the player's own on/off switch instead of Activate");
});

test("the category slot stays one-at-a-time: a second combat event is refused by the platform and offers no Activate", async () => {
  balances.berserker = 1;
  balances.deadeye = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  const busy = rowFor(p, "deadeye");
  assert.match(busy.detail, /slot in use/);
  assert.deepEqual(busy.show, [], "the interface does not offer an action the platform would refuse");
  assert.match(busy.panel.info, /Combat slot: Berserker/);
  respond = (route, options) => (route === "/events/activate"
    ? { ok: false, status: 409, json: { error: "combat already has Berserker active on this world." } }
    : defaultResponses(route, options));
  clickRow(p, rowId("deadeye"));
  pressActivate(p);
  await settle();
  assert.equal(Common.active("combat").eventId, "berserker");
  assert.match(p.messages.join("\n"), /category already has an event running/);
  assert.equal(balances.deadeye, 1, "the refused activation spent nothing");
});

test("Activate with nothing useful selected, or a claimable item selected, makes no platform request", async () => {
  const p = player();
  commands.events({ player: p, parts: ["events"] });
  await settle();
  calls.length = 0;
  pressActivate(p);
  assert.match(p.messages.join("\n"), /Select an event first/, "the empty combat slot is not an event");
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

test("a player can turn a running event off for themselves and back on, and only for themselves", async () => {
  balances.berserker = 1;
  let disabled = [];
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  respond = (route, options) => {
    if (route === "/events/preferences" && options.method === "PUT") {
      disabled = options.body.disabled ? [options.body.eventId] : [];
      return { ok: true, status: 200, json: { disabledEventIds: disabled } };
    }
    if (route.startsWith("/events/account")) {
      return { ok: true, status: 200, json: { account: { userId: "user-1", paepointsBalance: 900, tokens: tokenRows(), disabledEventIds: disabled } } };
    }
    return defaultResponses(route, options);
  };
  clickTab(p, TAB.LIVE);
  clickRow(p, rowId("berserker"));
  const running = rowFor(p, "berserker");
  assert.equal(running.panel.toggle, "Disable for me");
  assert.equal(running.panel.info3, "Effects for you: ON");
  assert.match(running.panel.description, /only affects you/, "the panel explains the switch is personal");

  calls.length = 0;
  pressToggle(p);
  await settle();
  await settle();
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put.route, "/events/preferences");
  assert.deepEqual({ ...put.body }, { userId: "user-1", eventId: "berserker", disabled: true });
  assert.equal(Common.effectsEnabled(p, "berserker"), false, "the event no longer affects this player");
  const off = rowFor(p, "berserker");
  assert.equal(off.panel.toggle, "Enable for me");
  assert.equal(off.panel.info3, "Effects for you: OFF");
  assert.match(off.detail, /\(off\)/);
  assert.equal(Common.active("combat").eventId, "berserker", "the event itself keeps running for the world");
  assert.equal(Common.effectsEnabled(player("someone-else"), "berserker"), true, "other players are unaffected");

  pressToggle(p);
  await settle();
  await settle();
  assert.equal(Common.effectsEnabled(p, "berserker"), true);
  assert.equal(rowFor(p, "berserker").panel.toggle, "Disable for me");
});

test("every event has a readable description, including the running one and one whose slot is taken", async () => {
  balances.berserker = 1;
  const p = player();
  await openAndSelect(p, "berserker");
  pressActivate(p);
  await settle();
  await settle();
  for (const event of Common.catalog()) {
    const row = rowFor(p, event.id);
    assert.ok(row.panel.description.startsWith(event.description), `${event.id} shows its description`);
  }
  assert.match(rowFor(p, "berserker").panel.subtitle, /Combat event - Live/, "the running event still shows its description and status");
  assert.match(rowFor(p, "deadeye").panel.subtitle, /slot in use/);
});

test("the countdown uses the website's format and ticks every second without resending an unchanged list", async () => {
  assert.equal(Common.remainingLabel(1_000 + 45_000, 1_000), "45s");
  assert.equal(Common.remainingLabel(1_000 + 5 * 60_000 + 12_000, 1_000), "5m 12s");
  assert.equal(Common.remainingLabel(1_000 + 60 * 60_000, 1_000), "1h");
  assert.equal(Common.remainingLabel(1_000 + (89 * 60 + 59) * 1000, 1_000), "1h 29m");
  assert.equal(Common.remainingLabel(1_000 + (49 * 3600 + 120) * 1000, 1_000), "2d 1h");
  assert.equal(Common.remainingLabel(1_000, 1_000), "ending");
  assert.equal(Common.remainingLabel(null), "ending");

  await withClock(async (clock) => {
    // A hosted world only ever shows what the platform reports, so the activation arrives
    // through the same /events answer a real one would.
    const activation = platformActivation("deadeye", { endsInMs: 125_500, by: "Pat" });
    respond = (route, options) => (route === "/events" && (options.method ?? "GET") === "GET"
      ? { ok: true, status: 200, json: { events: { combat: activation, skilling: null, utility: null } } }
      : defaultResponses(route, options));
    const p = player();
    commands.events({ player: p, parts: ["events"] });
    await settle();
    await settle();
    customEvents["global-events:ui-refresh"]({ player: p });
    assert.match(rowFor(p, "deadeye").detail, /^ - Live 2m 6s$/);
    const settled = p.sends.length;

    customEvents["global-events:ui-refresh"]({ player: p });
    assert.equal(p.sends.length, settled, "nothing changed, so nothing is sent");

    clock.advance(1000);
    customEvents["global-events:ui-refresh"]({ player: p });
    assert.equal(p.sends.length, settled + 1, "one second later the rows are sent once");
    assert.equal(p.sends.at(-1), uid(COMPONENT.DATA), "only the rows change; the layout and selection are left alone");
    assert.match(rowFor(p, "deadeye").detail, /^ - Live 2m 5s$/);
    assert.match(rowFor(p, "deadeye").panel.info, /^Time left: 2m 5s$/);
  });
});

test("activating an event announces it to everyone on the world, with who, how long and what it does", async () => {
  balances.berserker = 1;
  const watcher = player("watcher");
  const p = player();
  await withWorldPlayers([watcher, p], async () => {
    await openAndSelect(p, "berserker");
    pressActivate(p);
    await settle();
    await settle();
  });
  for (const heard of [watcher, p]) {
    const announcement = heard.messages.find((message) => /\[Global Event\]/.test(message));
    assert.ok(announcement, "every player on the world hears about it");
    assert.match(announcement, /Clicker activated Berserker for this world for 1h 3[01]m\./);
    assert.match(announcement, /Melee attacks have 100% accuracy/);
    assert.equal(heard.messages.filter((message) => /\[Global Event\]/.test(message)).length, 1, "announced once");
  }
});

test("an activation made on the website is announced even when a quiet sync sees it first, and only once", async () => {
  const watcher = player("watcher");
  const activation = platformActivation("deadeye", { startedAgoMs: 4000, by: "WebsitePat", id: "activation-website-1" });
  respond = (route, options) => (route === "/events" && (options.method ?? "GET") === "GET"
    ? { ok: true, status: 200, json: { events: { combat: activation, skilling: null, utility: null } } }
    : defaultResponses(route, options));
  await withWorldPlayers([watcher], async () => {
    const first = await Common.syncWorld({ reason: "ui", announce: false });
    assert.equal(first.changed, true);
    assert.equal(watcher.messages.filter((message) => /WebsitePat activated Deadeye/.test(message)).length, 1);
    await Common.syncWorld({ reason: "poll" });
    await Common.syncWorld({ reason: "login", announce: false });
    assert.equal(watcher.messages.filter((message) => /activated Deadeye/.test(message)).length, 1, "later syncs do not announce it again");
  });
});

test("a late login or a world restart does not re-announce an activation that is already old", async () => {
  const watcher = player("watcher");
  const activation = platformActivation("deadeye", { startedAgoMs: 10 * 60_000, by: "Earlier", id: "activation-old-1" });
  respond = (route, options) => (route === "/events" && (options.method ?? "GET") === "GET"
    ? { ok: true, status: 200, json: { events: { combat: activation, skilling: null, utility: null } } }
    : defaultResponses(route, options));
  await withWorldPlayers([watcher], async () => {
    const result = await Common.syncWorld({ reason: "login", announce: false });
    assert.equal(result.changed, true, "the world still learns about the running event");
    assert.equal(watcher.messages.length, 0, "but nobody is told it just started");
  });
});

test("the website's Combat, Skilling and Utility symbols are served as server sprites at the sizes the interface draws", () => {
  const loaded = Sprites.loadSprites(path.resolve(__dirname, "../data/sprites"));
  for (const [group, size] of [["ROW", 22], ["PANEL", 32]]) {
    for (const category of Common.CATEGORIES) {
      const id = SPRITE[group][category];
      assert.ok(id > 30000, `${group} ${category} sprite id ${id} sits in the server-sprite range, apart from the banner`);
      const png = Buffer.from(loaded.get(id) ?? "", "base64");
      assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", `sprite ${id} (${group} ${category}) exists`);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `sprite ${id} is ${size}x${size}`);
    }
  }
  const ids = Object.values(SPRITE).flatMap((group) => Object.values(group));
  assert.equal(new Set(ids).size, ids.length, "no two symbols share an id");
  assert.equal(Sprites.spritesResource({}, [String(SPRITE.ROW.combat)]), undefined, "served only once the world has loaded its sprite directory");
});

