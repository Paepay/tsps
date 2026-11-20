// Run after `yarn build`: node --test tests/global-events-skilling.test.cjs
// Paepay/tsps#65: Endless Harvest banking, Abundance doubling with its XP, Infernal Gathering,
// Production Master batching and Trickster success requests, each gated by the player's toggle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Location } = require("../dist/game/model/Location");

const Common = require("../plugins/events/global/Common.GlobalEvents");
const Skilling = require("../plugins/events/global/Skilling.GlobalEvents");

let core;
let I;
let store;
const custom = new Map();

function on(name, handler) {
  if (!custom.has(name)) custom.set(name, []);
  custom.get(name).push(handler);
}

function emit(name, event) {
  for (const handler of custom.get(name) ?? []) handler(event);
  return event;
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  I = core.ItemIdentifiers;
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
  const api = new Proxy({
    core,
    onCustomEvent: on,
    emitCustomEvent: emit,
  }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  Skilling.attach(api);
});

function activate(eventId, minutes = 30) {
  const startedAt = Date.now();
  return Common.activate(eventId, { startedAt, endsAt: startedAt + minutes * 60_000 });
}

function player(name = "skiller") {
  const p = new Player(null);
  p.setUsername(name);
  p.setLocation(new Location(3200, 3200, 0));
  p.setRegistered(true);
  const sender = new Proxy({}, { get: () => () => sender });
  p.getPacketSender = () => sender;
  return p;
}

const banked = (p, itemId) => p.getBank(core.Bank.getTabForItem(p, itemId)).getAmount(itemId);
const xp = (p, skill) => p.getSkillManager().getExperience(skill);
const gather = (p, itemId, amount, skill, experience = 0, stored = 0) =>
  ({ player: p, itemId, amount, skill, xp: experience, stored });

test("Endless Harvest banks every gathered resource, even with a full inventory", () => {
  Common.testing.reset();
  activate("endless-harvest");
  const p = player();
  const ore = gather(p, I.IRON_ORE, 1, core.Skill.MINING, 35);
  emit("storage:gather", ore);
  assert.equal(ore.stored, 1, "the inventory gets nothing");
  assert.equal(banked(p, I.IRON_ORE), 1);

  const room = { player: p, itemId: I.LOGS, skill: core.Skill.WOODCUTTING, room: false };
  emit("storage:room", room);
  assert.equal(room.room, true, "the bank's room keeps gathering going");

  while (!p.getInventory().isFull()) p.getInventory().adds(I.BONES, 1);
  const full = gather(p, I.LOGS, 1, core.Skill.WOODCUTTING, 25);
  emit("storage:gather", full);
  assert.equal(full.stored, 1);
  assert.equal(banked(p, I.LOGS), 1, "a full inventory does not lose the log");

  const basket = gather(p, I.LOGS, 2, core.Skill.WOODCUTTING, 50, 1);
  emit("storage:gather", basket);
  assert.equal(basket.stored, 2, "a log basket kept one; the other is banked");
  assert.equal(banked(p, I.LOGS), 2, "only the resource not already in the basket is banked");

  const hunter = { player: p, itemId: I.RAW_PYRE_FOX, skill: core.Skill.HUNTER, room: false };
  emit("storage:room", hunter);
  assert.equal(hunter.room, false, "another skill's catch is not banked");

  Common.setEffectsEnabled(p, "endless-harvest", false);
  const off = gather(p, I.RAW_SHRIMPS, 1, core.Skill.FISHING, 10);
  emit("storage:gather", off);
  assert.equal(off.stored, 0);
});

test("Abundance doubles the resource in the inventory and pays the extra's XP", () => {
  Common.testing.reset();
  activate("abundance");
  const p = player();
  const before = xp(p, core.Skill.WOODCUTTING);
  const request = gather(p, I.LOGS, 1, core.Skill.WOODCUTTING, 25);
  emit("storage:gather", request);
  assert.equal(request.stored, 0, "the gatherer still places the base resource");
  assert.equal(p.getInventory().getAmount(I.LOGS), 1, "the extra log is placed by the event");
  assert.equal(xp(p, core.Skill.WOODCUTTING) - before, 25, "the extra log pays its own XP");

  const room = { player: p, itemId: I.LOGS, skill: core.Skill.WOODCUTTING, room: false };
  emit("storage:room", room);
  assert.equal(room.room, true, "room for the extra keeps chopping");

  const full = player("abundance-full");
  while (!full.getInventory().isFull()) full.getInventory().adds(I.BONES, 1);
  const noRoom = gather(full, I.LOGS, 1, core.Skill.WOODCUTTING, 25);
  emit("storage:gather", noRoom);
  assert.equal(full.getInventory().getAmount(I.LOGS), 0, "no room means no extra, not a lost base");
});

test("Infernal Gathering burns logs, smelts ore and cooks fish with the right XP", () => {
  Common.testing.reset();
  activate("infernal-gathering");
  const p = player();
  on("firemaking:log-xp", (request) => { if (request.logId === I.LOGS) request.xp = 40; });
  on("smithing:bar-for-ore", (request) => {
    if (request.oreId === I.IRON_ORE) { request.barId = I.IRON_BAR; request.xp = 20; }
  });
  on("cooking:cooked", (request) => {
    if (request.rawId === I.RAW_SHRIMPS) { request.cookedId = I.SHRIMPS; request.xp = 30; }
  });

  const firemaking = xp(p, core.Skill.FIREMAKING);
  const logs = gather(p, I.LOGS, 2, core.Skill.WOODCUTTING, 50);
  emit("storage:gather", logs);
  assert.equal(logs.stored, 2);
  assert.equal(logs.gatherProcessed, true);
  assert.equal(p.getInventory().getAmount(I.LOGS), 0, "the logs are burned, not kept");
  assert.equal(xp(p, core.Skill.FIREMAKING) - firemaking, 80);

  const smithing = xp(p, core.Skill.SMITHING);
  const ore = gather(p, I.IRON_ORE, 1, core.Skill.MINING, 35);
  emit("storage:gather", ore);
  assert.equal(p.getInventory().getAmount(I.IRON_BAR), 1);
  assert.equal(p.getInventory().getAmount(I.IRON_ORE), 0);
  assert.equal(xp(p, core.Skill.SMITHING) - smithing, 20);

  const cooking = xp(p, core.Skill.COOKING);
  const fish = gather(p, I.RAW_SHRIMPS, 1, core.Skill.FISHING, 10);
  emit("storage:gather", fish);
  assert.equal(p.getInventory().getAmount(I.SHRIMPS), 1);
  assert.equal(xp(p, core.Skill.COOKING) - cooking, 30);

  const room = { player: p, itemId: I.RAW_SHRIMPS, skill: core.Skill.FISHING, room: false };
  emit("storage:room", room);
  assert.equal(room.room, true, "the processed output's room keeps fishing");

  // A full inventory keeps the raw resource instead of destroying it.
  const full = player("infernal-full");
  while (!full.getInventory().isFull()) full.getInventory().adds(I.BONES, 1);
  const raw = gather(full, I.RAW_SHRIMPS, 1, core.Skill.FISHING, 10);
  emit("storage:gather", raw);
  assert.equal(raw.stored, 0);
  assert.equal(raw.gatherProcessed, undefined, "the normal gatherer still places the fish");

  Common.setEffectsEnabled(p, "infernal-gathering", false);
  const usual = gather(p, I.LOGS, 1, core.Skill.WOODCUTTING, 25);
  emit("storage:gather", usual);
  assert.equal(usual.stored, 0, "an opted-out player keeps the log");
});

test("Production Master batches whole inventories, at most 28, and skips stackable potion secondaries", () => {
  Common.testing.reset();
  activate("production-master");
  const p = player();
  const request = (skill, kind, recipe = null) => {
    const event = { player: p, skill, kind, recipe, actions: 1 };
    emit("skills:actions-per-cycle", event);
    return event.actions;
  };
  assert.equal(request(core.Skill.SMITHING, "smelt"), 28);
  assert.equal(request(core.Skill.HERBLORE, "clean"), 28);
  assert.equal(request(core.Skill.FLETCHING, "arrows"), 10, "the per-kind cap");
  assert.equal(request(core.Skill.HERBLORE, "mix", { ingredients: [{ id: I.FEATHER }] }), 1,
    "a stackable secondary is not batched (it would duplicate the stack)");
  assert.equal(request(core.Skill.HERBLORE, "mix", { ingredients: [{ id: I.GUAM_LEAF }] }), 28);
  assert.equal(request(core.Skill.ATTACK, "smelt"), 1, "a skill outside the batch list is untouched");
  assert.equal(request(core.Skill.SMITHING, "not-a-kind"), 1);

  Common.setEffectsEnabled(p, "production-master", false);
  assert.equal(request(core.Skill.SMITHING, "smelt"), 1);
});

test("Trickster guarantees pickpocket, stall, blackjack, lock and Hunter success, and nothing else", () => {
  Common.testing.reset();
  activate("trickster");
  const p = player();
  const events = ["thieving:pickpocket-target", "thieving:stall-success", "thieving:blackjack-success", "thieving:lock-success"];
  for (const name of events) {
    const event = { player: p, alwaysSucceeds: false };
    emit(name, event);
    assert.equal(event.alwaysSucceeds, true, name);
  }
  const catchRoll = { player: p, npcId: 1, chance: 0.3 };
  emit("hunter:catch-chance", catchRoll);
  assert.equal(catchRoll.chance, 1);

  Common.setEffectsEnabled(p, "trickster", false);
  const off = { player: p, alwaysSucceeds: false };
  emit("thieving:stall-success", off);
  assert.equal(off.alwaysSucceeds, false);
  const usual = { player: p, npcId: 1, chance: 0.3 };
  emit("hunter:catch-chance", usual);
  assert.equal(usual.chance, 0.3);
});

test("only one skilling event can run at a time", () => {
  Common.testing.reset();
  assert.equal(activate("endless-harvest").ok, true);
  const second = activate("abundance");
  assert.equal(second.ok, false);
  assert.match(second.error, /skilling event is already running/);
  assert.equal(Common.active("skilling").eventId, "endless-harvest");
});
