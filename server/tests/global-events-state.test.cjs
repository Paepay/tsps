// Run after `yarn build`: node --test tests/global-events-state.test.cjs
// Paepay/tsps#65: the world's event catalog, the one-slot-per-category rule, persisted timers,
// the HUD state payload and per-player opt-outs scoped to the event instance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Location } = require("../dist/game/model/Location");
const { setPlatformAccess } = require("../plugins/paescape/PaeScapeBridge");

const Common = require("../plugins/events/global/Common.GlobalEvents");

const EXPECTED = {
  combat: ["Berserker", "Deadeye", "Mystique", "Onslaught", "Bloodthirst"],
  skilling: ["Endless Harvest", "Abundance", "Infernal Gathering", "Production Master", "Trickster"],
  utility: ["Rags to Riches", "Accelerate", "Prodigy", "Banker's Note", "Master's Arsenal"],
};
let store;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
});

function player(name = "event-player") {
  const p = new Player(null);
  p.setUsername(name);
  p.setLocation(new Location(3200, 3200, 0));
  p.setRegistered(true);
  return p;
}

function activate(eventId, minutes = 5) {
  const startedAt = Date.now();
  return Common.activate(eventId, { actor: "tester", startedAt, endsAt: startedAt + minutes * 60_000 });
}

test("the catalog is exactly the fifteen owner-named events in their three categories", () => {
  const catalog = Common.catalog();
  assert.equal(catalog.length, 15);
  for (const [category, names] of Object.entries(EXPECTED)) {
    const actual = catalog.filter((event) => event.category === category).map((event) => event.name);
    assert.deepEqual(actual, names, category);
  }
  for (const event of catalog) {
    assert.ok(Number.isInteger(event.iconItemId) && event.iconItemId > 0, `${event.name} has a HUD icon`);
    assert.ok(event.description.length > 0);
  }
});

test("one event per category: a second activation is refused without disturbing the first", () => {
  Common.testing.reset();
  const first = activate("berserker");
  assert.equal(first.ok, true);
  const slot = first.slot;
  const second = activate("deadeye");
  assert.equal(second.ok, false);
  assert.match(second.error, /combat event is already running/);
  assert.equal(Common.active("combat").instanceId, slot.instanceId, "the first instance is untouched");
  assert.equal(activate("endless-harvest").ok, true, "another category may run at the same time");
  assert.equal(activate("accelerate").ok, true);
  assert.equal(Common.activeSlots().length, 3);
});

test("state survives a reload with its slots, activator and timer", () => {
  Common.testing.reset();
  const started = Date.now() - 60_000;
  const result = Common.activate("mystique", { actor: "Reloader", startedAt: started, endsAt: started + 300_000 });
  assert.equal(result.ok, true);
  Common.testing.reset();
  assert.equal(Common.testing.load(), true);
  const slot = Common.active("combat");
  assert.deepEqual(
    { eventId: slot.eventId, activatedBy: slot.activatedBy, instanceId: slot.instanceId },
    { eventId: "mystique", activatedBy: "Reloader", instanceId: result.slot.instanceId },
  );
  assert.equal(Common.remainingSeconds(slot) > 0, true);
});

test("expired events end themselves and free the slot", () => {
  Common.testing.reset();
  const started = Date.now() - 120_000;
  Common.activate("onslaught", { startedAt: started, endsAt: started + 1_000 });
  assert.equal(Common.active("combat"), null);
  assert.equal(activate("deadeye").ok, true, "the expired slot can be used again");
});

test("the HUD payload carries the newest icon, three category slots and a changing active key", () => {
  Common.testing.reset();
  const p = player();
  const first = activate("endless-harvest", 30);
  const one = Common.statePayload(p);
  assert.equal(one.type, "state");
  assert.equal(one.slots.skilling.name, "Endless Harvest");
  assert.equal(one.slots.combat, null);
  assert.equal(one.iconName, "Endless Harvest");
  assert.equal(one.iconItemId, Common.definition("endless-harvest").iconItemId);
  assert.equal(one.slots.skilling.enabled, true);
  assert.equal(typeof one.activeKey, "string");
  assert.ok(one.activeKey.includes(first.slot.instanceId));

  const two = activate("accelerate", 30);
  const after = Common.statePayload(p);
  assert.notEqual(after.activeKey, one.activeKey, "a new activation is unseen");
  assert.equal(after.slots.utility.name, "Accelerate");
  assert.equal(after.iconName, "Accelerate", "the newest activation is the icon");
  assert.ok(after.activeKey.includes(two.slot.instanceId));
});

test("an opt-out is scoped to the account and event id, not to one activation", () => {
  Common.testing.reset();
  const p = player("opt-out");
  activate("abundance", 30);
  assert.equal(Common.effectsEnabled(p, "abundance"), true, "default on");
  assert.deepEqual(Common.setEffectsEnabled(p, "abundance", false), { ok: true, enabled: false });
  assert.equal(Common.effectsEnabled(p, "abundance"), false);
  assert.deepEqual(p.getAttribute(Common.OPT_OUT_ATTRIBUTE), ["abundance"]);

  // The same activation reconnects: the preference follows the character attribute.
  const again = player("opt-out");
  again.setAttribute(Common.OPT_OUT_ATTRIBUTE, p.getAttribute(Common.OPT_OUT_ATTRIBUTE));
  assert.equal(Common.effectsEnabled(again, "abundance"), false);

  // Turning it back on removes exactly that instance.
  Common.setEffectsEnabled(p, "abundance", true);
  assert.deepEqual(p.getAttribute(Common.OPT_OUT_ATTRIBUTE), []);

  // A new activation of the same event is still off: the platform scopes this to the account
  // and event id, and the choice survives reconnects and restarts.
  Common.setEffectsEnabled(p, "abundance", false);
  Common.end("skilling");
  Common.activate("abundance", { startedAt: Date.now(), endsAt: Date.now() + 60_000 });
  assert.equal(Common.effectsEnabled(p, "abundance"), false);
  assert.deepEqual(Common.disabledEvents(p), ["abundance"]);

  // The platform's disabledEventIds replaces the local list; unknown ids are ignored.
  Common.applyDisabledEvents(p, ["accelerate", "not-an-event"]);
  assert.deepEqual(p.getAttribute(Common.OPT_OUT_ATTRIBUTE), ["accelerate"]);
  assert.equal(Common.effectsEnabled(p, "abundance"), true);
});

test("every catalog row carries the frozen platform contract fields", () => {
  for (const event of Common.catalog()) {
    assert.equal(event.pvp, false, `${event.id} is PvP-safe`);
    assert.equal(typeof event.summary, "string");
    assert.ok(event.summary.length > 0, `${event.id} has a summary`);
    assert.equal(typeof event.effect, "object");
    assert.equal(typeof event.effect.kind, "string");
  }
});

test("a hosted world imports and clears platform slots and refuses local activation or end", async () => {
  Common.testing.reset();
  const now = Date.now();
  const slot = (eventId, activationId) => {
    const event = Common.definition(eventId);
    return {
      category: event.category,
      eventId,
      name: event.name,
      summary: event.summary,
      description: event.description,
      effect: event.effect,
      startsAt: new Date(now - 1000).toISOString(),
      endsAt: new Date(now + 300_000).toISOString(),
      activationId,
      activator: { userId: "u1", displayName: "Platformer" },
    };
  };
  let world = { combat: slot("berserker", "activation-one"), skilling: null, utility: null };
  setPlatformAccess({
    platformOrigin: () => "https://platform.example",
    worldRequest: async () => ({ ok: true, status: 200, json: { events: world } }),
  });
  try {
    assert.equal(Common.hosted(), true);
    const first = await Common.syncWorld({ reason: "test" });
    assert.equal(first.changed, true);
    assert.equal(Common.active("combat").eventId, "berserker");
    assert.equal(Common.active("combat").activatedBy, "Platformer");
    assert.equal(Common.active("combat").effect.kind, "perfect-accuracy");

    assert.equal(Common.activate("deadeye", { startedAt: now, endsAt: now + 60_000 }).ok, false);
    assert.equal(Common.end("combat"), false);
    assert.equal(Common.active("combat").eventId, "berserker", "a hosted world cannot clear a slot");

    world = { combat: null, skilling: null, utility: null };
    const second = await Common.syncWorld({ reason: "test" });
    assert.equal(second.changed, true);
    assert.equal(Common.active("combat"), null, "the platform's clear is applied");
  } finally {
    setPlatformAccess(null);
  }
});

test("opting out of one event leaves another category's effects on", () => {
  Common.testing.reset();
  const p = player();
  activate("berserker", 30);
  activate("accelerate", 30);
  Common.setEffectsEnabled(p, "berserker", false);
  assert.equal(Common.effectsEnabled(p, "berserker"), false);
  assert.equal(Common.effectsEnabled(p, "accelerate"), true);
});

test("ending clears the world state and broadcasts a changed revision", () => {
  Common.testing.reset();
  const p = player();
  activate("trickster", 30);
  const before = Common.revision();
  assert.equal(Common.end("skilling"), true);
  assert.equal(Common.revision(), before + 1);
  assert.equal(Common.active("skilling"), null);
  assert.equal(Common.statePayload(p).slots.skilling, null);
  assert.equal(Common.end("skilling"), false, "nothing left to end");
});
