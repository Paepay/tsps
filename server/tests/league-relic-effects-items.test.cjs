// Run after `yarn build`: node --test tests/league-relic-effects-items.test.cjs
// The item and teleport relics (docs/leagues.md): Fairy's Flight and Banker's Note (both leagues),
// Globetrotter (Trailblazer Reloaded), Clue Compass, Total Recall, Grimoire and Reloaded (Raging
// Echoes), plus Trailblazer Reloaded's tier 3 Crystal of memories passive (also Level-Up). Each
// works for a character of its league who chose it (or reached the passive's tier), and for nobody
// else. The destinations come from their owners (fairy rings, spirit trees, the jewellery box, the
// spellbooks, STASH units, the trail's last-read clue); the teleport is recorded.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before, beforeEach, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { GameConstants } = require("../dist/game/GameConstants");
const { Skill } = require("../dist/game/model/Skill");
const { Location } = require("../dist/game/model/Location");
const { Item } = require("../dist/game/model/Item");

let core;
const hooks = {};
const custom = {};
const itemActions = new Map();
const realRandom = Math.random;
let I;
let prompts = [];
let teleports = [];
let menuPlayer = null;
let realTeleport;
let realCheckReqs;
let Unlock;
let TrailRuntime;
let MageArena;
let spawned = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  I = core.ItemIdentifiers;
  GameConstants.setWorldProfile("league"); // a Trailblazer Reloaded world (the league type is the plugin config below)
  const lists = {};
  const on = (name) => (handler) => {
    (lists[name] ??= []).push(handler);
    hooks[name] = (event) => {
      for (const attached of lists[name]) attached(event);
    };
  };
  const api = new Proxy({
    core,
    persistAttribute() {},
    log() {},
    getPluginConfig: (key, fallback) => (key === "league:type" ? 4 : fallback),
    setWorldProfile: (profile) => GameConstants.setWorldProfile(profile),
    getSkillManager: () => require("../dist/game/content/skill/SkillManager").SkillManager,
    getAreaManager: () => ({ inMulti: () => false }),
    registerCommand: (name, handler) => (hooks[`command:${name}`] = handler),
    registerMagicAttackAccuracyModifier() {},
    registerMagicDamageBonusModifier() {},
    registerMeleeAttackAccuracyModifier() {},
    registerRangedAttackAccuracyModifier() {},
    registerMeleeDefenseModifier() {},
    registerMagicDefenseModifier() {},
    registerWeaponProfile() {},
    registerRangedAmmoHandler() {},
    onItemAction: (name, actions) => {
      // Chain like PluginManager: a handler returning false passes the click to the next.
      if (typeof name !== "string") return;
      const merged = { ...(itemActions.get(name) ?? {}) };
      for (const [option, handler] of Object.entries(actions)) {
        const previous = merged[option];
        merged[option] = previous
          ? (event) => {
              const first = previous(event);
              if (first !== false || event.handled) return first;
              return handler(event);
            }
          : handler;
      }
      itemActions.set(name, merged);
    },
    sendMultiChatboxPrompt: (player, title, ...pairs) => {
      const options = [];
      for (let i = 0; i < pairs.length; i += 2) options.push([pairs[i], pairs[i + 1]]);
      prompts.push({ player, title, options });
    },
    encodePluginMessage: (channel, data) => ({ channel, data }),
    onInterfaceActionButton: (ids, handler) => {
      for (const id of [].concat(ids)) on(`button:${id}`)(handler);
    },
    onCustomEvent: (name, handler) => (custom[name] = (custom[name] ?? []).concat(handler)),
    emitCustomEvent: (name, payload) => {
      for (const handler of custom[name] ?? []) handler(payload);
    },
    spawnNpc: (definition) => {
      const npc = {
        definition,
        movements: [],
        animations: [],
        following: null,
        registered: true,
        setPet() {},
        setUntargetable() {},
        setFollowing(target) { this.following = target; },
        setMobileInteraction() {},
        getFollowing() { return this.following; },
        isRegistered() { return this.registered; },
        getAttackAnim() { return 1; },
        performAnimation(animation) { this.animations.push(animation); },
        getMovementQueue() { return { reset() {} }; },
        calculateDistance() { return 1; },
      };
      spawned.push(npc);
      return npc;
    },
    removeNpc: (npc) => { npc.registered = false; },
  }, { get: (target, key) => (key in target ? target[key] : on(String(key))) });
  require("../plugins/modes/Base.LeagueMode").register(api);
  require("../plugins/modes/Points.LeagueMode").register(api);
  require("../plugins/modes/Relics.LeagueMode").register(api);
  const AreaCommon = require("../plugins/modes/leagueareas/Common.LeagueAreaUnlocks");
  const Regions = require("../plugins/modes/leagueareas/Regions.LeagueAreaUnlocks");
  AreaCommon.init(api);
  custom["league:area-at"] = [(query) => {
    if (query.base !== true || query.area !== null) return;
    query.area = Regions.areaAt(null, query.x, query.y);
    query.name = query.area === null ? null : AreaCommon.area(query.area).name;
  }];
  require("../plugins/world/FairyRings.plugin").register(api);
  require("../plugins/world/SpiritTrees.plugin").register(api);
  require("../plugins/treasuretrails/TreasureTrails.plugin").register(api);
  require("../plugins/skills/construction/Core.Construction").init(api);
  require("../plugins/skills/construction/JewelleryBox.Construction").attachJewelleryBoxes(api);
  MageArena = require("../plugins/minigames/magearena/Spells.MageArena");
  MageArena(api);
  Unlock = require("../plugins/modes/leaguerelics/Unlock.LeagueRelics");
  TrailRuntime = require("../plugins/treasuretrails/trails/Runtime.TreasureTrails");
  // The teleport itself is the core's; the relics' choice of where is what is checked here.
  realTeleport = core.TeleportHandler.teleport;
  realCheckReqs = core.TeleportHandler.checkReqs;
  core.TeleportHandler.teleport = (player, location, type, warning, onArrival) => {
    teleports.push({ player, location });
    onArrival?.();
  };
});

beforeEach(() => {
  prompts = [];
  teleports = [];
  menuPlayer = null;
  spawned = [];
});

afterEach(() => {
  Math.random = realRandom;
  core.TeleportHandler.checkReqs = realCheckReqs;
});

test.after(() => {
  core.TeleportHandler.teleport = realTeleport;
});

/** A real player of `profile`, logged in, with the given relic picks (tier index -> slot). */
function character(name, profile, picks = {}, leagueType = 4) {
  const player = new Player(null);
  player.setUsername(name);
  player.setProfile(profile);
  player.setLocation(new Location(3200, 3200, 0));
  player.setRegistered(true);
  player.setNeedsPlacement(false);
  const sender = new Proxy({}, { get: () => () => sender });
  player.getPacketSender = () => sender;
  player.sent = { packets: [] };
  player.getSession = () => ({
    sendClientPacket: (packet) => {
      player.sent.packets.push(packet);
      menuPlayer = player;
      return true;
    },
  });
  player.messages = [];
  player.sendMessage = (message) => player.messages.push(message);
  if (profile === "league") {
    player.setAttribute("league:type", leagueType);
    player.setAttribute("league:relics", picks);
  }
  hooks.onPlayerLogin({ player, username: name, isNewAccount: false, profile });
  return player;
}

function cases(picks, league = 4) {
  return {
    relic: character("relic", "league", picks, league),
    without: character("without", "league", {}, league),
    other: character("other", "league", picks, league === 4 ? 5 : 4),
    main: character("main", "main"),
  };
}

function others(who) {
  return [who.without, who.other, who.main];
}

function click(itemName, option, player) {
  const event = { player, item: null, slot: 0, option, handled: false };
  itemActions.get(itemName)[option](event);
  return event;
}

const TELEPORT_MENU_CHANNEL = "teleport-menu";

/** The player's open teleport-menu screen, or null after the menu closed. */
function menuOf(player) {
  const packets = player.sent.packets.filter((packet) => packet.channel === TELEPORT_MENU_CHANNEL);
  for (let index = packets.length - 1; index >= 0; index--) {
    if (packets[index].data.type === "close") return null;
    if (packets[index].data.type === "screen") return packets[index].data;
  }
  return null;
}

/** A screen as the old prompt assertions saw it: locked entries struck and Back appended. */
function menuView(player) {
  const screen = menuOf(player);
  if (!screen) return null;
  const labels = screen.entries.map((entry) => (entry.locked ? `<str>${entry.label}</str>` : entry.label));
  if (screen.canBack) labels.push("Back");
  return { ...screen, labels };
}

/** Sends a client teleport-menu action as the browser does. */
function menuMessage(player, data) {
  const event = { player, channel: TELEPORT_MENU_CHANNEL, data, handled: false };
  for (const handler of custom["network:plugin-message"] ?? []) handler(event);
  assert.equal(event.handled, true, "the teleport menu's message");
  return event;
}

/** Picks a region or destination by its label (exact, or the start of it), paging when needed. */
function choose(label, player = menuPlayer) {
  assert.ok(player, `a player with a menu for ${label}`);
  let screen = menuView(player);
  assert.ok(screen, `a menu with ${label}`);
  let found = screen.entries.find((entry) => entry.label === label)
    ?? screen.entries.find((entry) => entry.label.startsWith(label));
  for (let page = 0; !found && page < screen.pages; page++) {
    if (page === screen.page) continue;
    menuMessage(player, { type: "page", session: screen.session, page });
    screen = menuView(player);
    found = screen.entries.find((entry) => entry.label === label)
      ?? screen.entries.find((entry) => entry.label.startsWith(label));
  }
  if (label === "Back") {
    assert.ok(screen.canBack, "Back on the menu");
    menuMessage(player, { type: "back", session: screen.session });
    return;
  }
  assert.ok(found, `${label} on the menu "${screen.title}": ${screen.labels.join(", ")}`);
  menuMessage(player, {
    type: screen.stage === "regions" ? "region" : "destination",
    session: screen.session,
    index: found.index,
  });
}

const FAIRYS_FLIGHT_TR = { 1: 1 };
const FAIRYS_FLIGHT_RE = { 2: 3 };
const GLOBETROTTER = { 1: 2 };
const BANKERS_NOTE_TR = { 2: 1 };
const BANKERS_NOTE_RE = { 5: 2 };
const CLUE_COMPASS = { 2: 1 };
const TOTAL_RECALL = { 5: 1 };
const GRIMOIRE = { 6: 2 };
const RELOADED = { 3: 2 };
const BANK_HEIST = { 2: 2 };

const at = (teleport) => [teleport.location.getX(), teleport.location.getY(), teleport.location.getZ()];

test("Fairy's Flight (both leagues): fairy rings by code, spirit trees, tool leprechauns; the last destination; only unlocked areas", () => {
  const rings = [];
  for (const handler of custom["fairy-rings:destinations"]) handler({ list: rings });
  const ajr = rings.find((ring) => ring.code === "AJR");
  assert.ok(ajr, "the cache's AJR");
  for (const [picks, league] of [[FAIRYS_FLIGHT_TR, 4], [FAIRYS_FLIGHT_RE, 5]]) {
    teleports = [];
    const relic = character(`flight${league}`, "league", picks, league);
    click("Fairy mushroom", "Teleport", relic);
    const regions = menuView(relic);
    assert.equal(regions.stage, "regions");
    assert.equal(regions.entries[0].label, "Misthalin", "regions first, not fairy ring codes");
    assert.equal(regions.labels.some((label) => /^Fairy ring [A-Z]$/.test(label)), false, "no ring-letter groups");
    assert.equal(regions.labels.includes("Spirit trees"), false, "no standalone category");
    assert.equal(regions.labels.includes("Tool leprechauns"), false, "no standalone category");
    choose("Fremennik Province");
    choose("AJR");
    assert.deepEqual(at(teleports.at(-1)), [ajr.location.getX(), ajr.location.getY(), ajr.location.getZ()], `league ${league}: AJR`);
    click("Fairy mushroom", "Last-destination", relic);
    assert.equal(teleports.length, 2, "and there again");
    assert.deepEqual(at(teleports[1]), at(teleports[0]));
  }

  const who = cases(FAIRYS_FLIGHT_TR, 4);
  teleports = [];
  click("Fairy mushroom", "Spirit-tree", who.relic);
  assert.equal(menuView(who.relic).stage, "regions", "spirit trees are grouped by region");
  choose("Misthalin");
  assert.ok(menuView(who.relic).entries.some((entry) => /Grand Exchange/.test(entry.label)), "the Grand Exchange tree");
  choose("Grand Exchange");
  assert.ok(teleports.length === 1);
  click("Fairy mushroom", "Tool-leprechauns", who.relic);
  assert.equal(menuView(who.relic).stage, "regions", "tool leprechauns are grouped by region");
  choose(menuView(who.relic).entries[0].label);
  assert.ok(menuView(who.relic).entries.every((entry) => /^Near /.test(entry.label)), "named after their fairy rings");
  for (const player of [who.without, who.main]) {
    const before = player.sent.packets.length;
    click("Fairy mushroom", "Teleport", player);
    assert.equal(player.sent.packets.length, before, `${player.getUsername()}'s mushroom does nothing`);
  }

  // An area the character has not unlocked (as league-areas would answer).
  const area = (query) => { query.area = "asgarnia"; };
  const unlocked = (query) => { query.unlocked = ["misthalin"]; };
  custom["league:area-at"] = [area, ...(custom["league:area-at"] ?? [])];
  custom["league:areas"] = [unlocked, ...(custom["league:areas"] ?? [])];
  teleports = [];
  click("Fairy mushroom", "Last-destination", who.relic);
  assert.equal(teleports.length, 0, "a locked area");
  assert.match(who.relic.messages.at(-1), /haven't unlocked/);
  custom["league:area-at"] = custom["league:area-at"].filter((handler) => handler !== area);
  custom["league:areas"] = custom["league:areas"].filter((handler) => handler !== unlocked);
});

test("Globetrotter: the spellbooks' teleports and the jewellery box's, no higher than level 20 Wilderness", () => {
  const who = cases(GLOBETROTTER, 4);
  click("Globetrotter pendant", "Nexus", who.relic);
  const regions = menuView(who.relic);
  const labels = regions.entries.map((entry) => entry.label);
  assert.equal(labels[0], "Misthalin", "the first region, not the first spellbook");
  assert.ok(labels.indexOf("Misthalin") < labels.indexOf("Kandarin"));
  assert.equal(labels.includes("Standard"), false, "no spellbook heading");
  assert.equal(labels.includes("Ancient"), false, "no spellbook heading");
  assert.equal(labels.includes("Lunar"), false, "no spellbook heading");
  assert.equal(labels.includes("Arceuus"), false, "no spellbook heading");
  choose("Misthalin");
  choose("Varrock Teleport");
  assert.deepEqual(at(teleports.at(-1)), [3213, 3424, 0]);
  click("Globetrotter pendant", "Nexus", who.relic);
  choose("Kandarin");
  choose("Ape Atoll Teleport (Arceuus)");
  assert.deepEqual(at(teleports.at(-1)), [2769, 2703, 0], "the Arceuus spell's southern cave, not the dungeon");
  click("Globetrotter pendant", "Jewellery", who.relic);
  choose("Castle Wars");
  assert.equal(teleports.length, 3, "a jewellery box destination");

  // Level 25 Wilderness: the pendant's limit is 20.
  let limit = null;
  core.TeleportHandler.checkReqs = (player, location, level) => { limit = level; return level >= 25; };
  click("Globetrotter pendant", "Nexus", who.relic);
  choose("Misthalin");
  choose("Lumbridge Teleport");
  assert.equal(limit, 20);
  assert.equal(teleports.length, 3, "refused from level 25");
  click("Globetrotter pendant", "Jewellery", who.relic);
  choose("Edgeville");
  assert.equal(limit, 30, "a glory destination teleports from level 30");
  for (const player of others(who)) {
    const before = player.sent.packets.length;
    click("Globetrotter pendant", "Nexus", player);
    assert.equal(player.sent.packets.length, before, `${player.getUsername()}'s pendant does nothing`);
  }
});

test("Globetrotter on a Level-Up world: the Nexus uses the base region map, not a seasonal profile", () => {
  const player = character("levelupglobetrotter", "main");
  const seasonal = (query) => {
    if (query.player !== player) return;
    query.league = null;
    query.unlocked = [];
  };
  const answer = (query) => {
    if (query.player !== player) return;
    query.league = 4;
    query.active = true;
  };
  const areas = (query) => {
    if (query.player !== player) return;
    query.active = true;
    query.unlocked = [1];
  };
  custom["league:areas"] = [seasonal, ...(custom["league:areas"] ?? [])];
  custom["level-up:relic-profile"] = [answer, ...(custom["level-up:relic-profile"] ?? [])];
  custom["level-up:area-profile"] = [areas, ...(custom["level-up:area-profile"] ?? [])];
  try {
    player.setAttribute("league:relics", GLOBETROTTER);
    click("Globetrotter pendant", "Nexus", player);
    const regions = menuView(player);
    assert.equal(regions.stage, "regions");
    assert.equal(regions.entries[0].label, "Misthalin");
    assert.equal(regions.entries[0].locked, false, "Misthalin is unlocked");
    assert.equal(regions.entries.find((entry) => entry.label === "Kandarin").locked, true,
      "a Level-Up region the player has not unlocked is struck through");
    choose("Kandarin");
    const error = player.sent.packets.filter((packet) => packet.channel === TELEPORT_MENU_CHANNEL
      && packet.data.type === "error").at(-1);
    assert.match(error.data.message, /haven't unlocked/, "the locked region explains itself");
    assert.equal(menuView(player).stage, "regions", "a locked region cannot be entered");
    choose("Misthalin");
    choose("Lumbridge Teleport");
    assert.deepEqual(at(teleports.at(-1)), [3221, 3218, 0]);
  } finally {
    custom["league:areas"] = custom["league:areas"].filter((handler) => handler !== seasonal);
    custom["level-up:relic-profile"] = custom["level-up:relic-profile"].filter((handler) => handler !== answer);
    custom["level-up:area-profile"] = custom["level-up:area-profile"].filter((handler) => handler !== areas);
  }
});

test("Fairy's Flight on a Level-Up world: destinations are grouped by region and locked by the Level-Up profile", () => {
  const player = character("levelupfairy", "main");
  const seasonal = (query) => {
    if (query.player !== player) return;
    query.league = null;
    query.unlocked = [];
  };
  const answer = (query) => {
    if (query.player !== player) return;
    query.league = 4;
    query.active = true;
  };
  const areas = (query) => {
    if (query.player !== player) return;
    query.active = true;
    query.unlocked = [1];
  };
  custom["league:areas"] = [seasonal, ...(custom["league:areas"] ?? [])];
  custom["level-up:relic-profile"] = [answer, ...(custom["level-up:relic-profile"] ?? [])];
  custom["level-up:area-profile"] = [areas, ...(custom["level-up:area-profile"] ?? [])];
  try {
    player.setAttribute("league:relics", FAIRYS_FLIGHT_TR);
    click("Fairy mushroom", "Teleport", player);
    const regions = menuView(player);
    assert.equal(regions.stage, "regions");
    assert.equal(regions.entries[0].label, "Misthalin");
    assert.equal(regions.entries[0].locked, false, "the default Level-Up region is open");
    assert.equal(regions.entries.find((entry) => entry.label === "Kandarin").locked, true,
      "a Level-Up region the player has not unlocked is struck through");
  } finally {
    custom["league:areas"] = custom["league:areas"].filter((handler) => handler !== seasonal);
    custom["level-up:relic-profile"] = custom["level-up:relic-profile"].filter((handler) => handler !== answer);
    custom["level-up:area-profile"] = custom["level-up:area-profile"].filter((handler) => handler !== areas);
  }
});

test("Banker's Note: preset copies (PvP presets on a league world) are refused, and only plain copies are noted", () => {
  const relic = character("notepreset", "league", BANKERS_NOTE_TR, 4);
  const inventory = relic.getInventory();
  inventory.add(new Item(I.BANKERS_NOTE, 1), false);
  const preset = () => {
    const item = new Item(I.LOGS, 1);
    for (const meta of [Item.UNTRADEABLE_META, Item.UNBANKABLE_META, Item.PRESET_META]) item.setMetaValue(meta, true);
    return item;
  };
  for (let i = 0; i < 3; i++) inventory.add(preset(), false);
  const note = inventory.getItems().find((item) => item?.getId() === I.BANKERS_NOTE);
  const logs = inventory.getItems().find((item) => item?.getId() === I.LOGS);
  hooks.onItemOnItem({ player: relic, usedItem: logs, usedWithItem: note, handled: false });
  const notedLogs = core.ItemDefinition.forId(I.LOGS).getNoteId();
  assert.equal(inventory.getAmount(notedLogs), 0, "no plain notes from preset logs");
  assert.equal(inventory.getAmount(I.LOGS), 3, "the preset logs stay");
  assert.equal(relic.messages.at(-1), "Preset items cannot be used for this.");
  for (let i = 0; i < 2; i++) inventory.add(new Item(I.LOGS, 1), false);
  hooks.onItemOnItem({ player: relic, usedItem: logs, usedWithItem: note, handled: false });
  assert.equal(inventory.getAmount(notedLogs), 2, "the two plain logs are noted");
  assert.equal(inventory.getAmount(I.LOGS), 3, "the three preset logs are left");
});

test("Banker's Note (both leagues): an item used on it is noted or unnoted; Activate repeats it, Toggle switches, the quantities", () => {
  for (const [picks, league] of [[BANKERS_NOTE_TR, 4], [BANKERS_NOTE_RE, 5]]) {
    const relic = character(`note${league}`, "league", picks, league);
    const inventory = relic.getInventory();
    inventory.add(new Item(I.BANKERS_NOTE, 1), false);
    for (let i = 0; i < 5; i++) inventory.add(new Item(I.LOGS, 1), false);
    const note = inventory.getItems().find((item) => item?.getId() === I.BANKERS_NOTE);
    const logs = inventory.getItems().find((item) => item?.getId() === I.LOGS);
    const use = { player: relic, usedItem: logs, usedWithItem: note, handled: false };
    hooks.onItemOnItem(use);
    assert.equal(use.handled, true);
    const notedLogs = core.ItemDefinition.forId(I.LOGS).getNoteId();
    assert.equal(inventory.getAmount(I.LOGS), 0, `league ${league}: noted`);
    assert.equal(inventory.getAmount(notedLogs), 5);
    click("Banker's note", "Toggle", relic);
    click("Banker's note", "Activate", relic);
    assert.equal(inventory.getAmount(I.LOGS), 5, "Activate, toggled, unnotes them");
    let entered;
    relic.setEnteredAmountAction = (action) => { entered = action; };
    click("Banker's note", "Note-Quantity", relic);
    entered.execute(2);
    click("Banker's note", "Toggle", relic);
    click("Banker's note", "Activate", relic);
    assert.equal(inventory.getAmount(notedLogs), 2, "two at a time");
  }

  // Noting a full inventory: logs and the note, no noted logs yet; the logs' slots make room.
  // Tier 3's Crystal of memories is already granted on login; remove it so this case is only the note.
  const gatherer = character("notegather", "league", BANKERS_NOTE_TR, 4);
  const pack = gatherer.getInventory();
  pack.delete(I.CRYSTAL_OF_ECHOES, pack.getAmount(I.CRYSTAL_OF_ECHOES));
  pack.add(new Item(I.BANKERS_NOTE, 1), false);
  while (pack.getFreeSlots() > 0) pack.add(new Item(I.LOGS, 1), false);
  assert.equal(pack.getAmount(I.LOGS), 27);
  const [packNote, packLogs] = [I.BANKERS_NOTE, I.LOGS].map((id) => pack.getItems().find((item) => item?.getId() === id));
  hooks.onItemOnItem({ player: gatherer, usedItem: packLogs, usedWithItem: packNote, handled: false });
  assert.equal(pack.getAmount(core.ItemDefinition.forId(I.LOGS).getNoteId()), 27, "all 27 noted");
  assert.equal(pack.getAmount(I.LOGS), 0);

  // Unnoting into a full inventory loses nothing: only what fits comes out.
  const full = character("notefull", "league", BANKERS_NOTE_TR, 4);
  const bag = full.getInventory();
  const notedLogs = core.ItemDefinition.forId(I.LOGS).getNoteId();
  bag.add(new Item(I.BANKERS_NOTE, 1), false).add(new Item(notedLogs, 10), false);
  while (bag.getFreeSlots() > 3) bag.add(new Item(I.BRONZE_DAGGER, 1), false);
  const use = (player) => {
    const [note, logs] = [I.BANKERS_NOTE, notedLogs].map((id) => player.getInventory().getItems().find((item) => item?.getId() === id));
    hooks.onItemOnItem({ player, usedItem: logs, usedWithItem: note, handled: false });
  };
  use(full);
  assert.equal(bag.getAmount(I.LOGS), 3, "three slots, three logs");
  assert.equal(bag.getAmount(notedLogs), 7, "and the other seven still noted");
  click("Banker's note", "Activate", full);
  assert.equal(bag.getAmount(I.LOGS) + bag.getAmount(notedLogs), 10, "a full inventory unnotes none and loses none");
  bag.deleteNumber(notedLogs, 7);
  bag.deleteNumber(I.LOGS, 3);
  click("Banker's note", "Activate", full);
  assert.match(full.messages.at(-1), /none of that/, "the remembered item gone");
  const who = cases(BANKERS_NOTE_TR, 4);
  for (const player of [who.without, who.main]) {
    player.getInventory().add(new Item(I.BANKERS_NOTE, 1), false).add(new Item(I.LOGS, 1), false);
    const [note, logs] = [I.BANKERS_NOTE, I.LOGS].map((id) => player.getInventory().getItems().find((item) => item?.getId() === id));
    const use = { player, usedItem: logs, usedWithItem: note, handled: false };
    hooks.onItemOnItem(use);
    assert.equal(use.handled, false, player.getUsername());
    assert.equal(player.getInventory().getAmount(I.LOGS), 1);
  }
});

test("Banker's Note remembers every item used on it, each in the direction it was used", () => {
  const relic = character("noteall", "league", BANKERS_NOTE_TR, 4);
  const inventory = relic.getInventory();
  const notedLogs = core.ItemDefinition.forId(I.LOGS).getNoteId();
  const notedDagger = core.ItemDefinition.forId(I.BRONZE_DAGGER).getNoteId();
  inventory.add(new Item(I.BANKERS_NOTE, 1), false);
  inventory.add(new Item(I.LOGS, 2), false);
  inventory.add(new Item(notedDagger, 3), false);
  const note = inventory.getItems().find((item) => item?.getId() === I.BANKERS_NOTE);
  const useOn = (itemId) => {
    const item = inventory.getItems().find((entry) => entry?.getId() === itemId);
    hooks.onItemOnItem({ player: relic, usedItem: item, usedWithItem: note, handled: false });
  };

  useOn(I.LOGS);
  inventory.add(new Item(I.LOGS, 2), false);
  useOn(notedDagger);
  inventory.add(new Item(notedDagger, 2), false);
  assert.equal(inventory.getAmount(notedLogs), 2, "the logs were noted");
  assert.equal(inventory.getAmount(I.BRONZE_DAGGER), 3, "the noted daggers were unnoted");
  assert.deepEqual(relic.getAttribute("league:bankers-note").items,
    { [I.LOGS]: "note", [I.BRONZE_DAGGER]: "unnote" }, "both items keep their own direction");

  click("Banker's note", "Activate", relic);
  assert.equal(inventory.getAmount(I.LOGS), 0, "Activate notes the logs it remembered");
  assert.equal(inventory.getAmount(notedLogs), 4);
  assert.equal(inventory.getAmount(notedDagger), 0, "and unnotes the daggers it remembered");
  assert.equal(inventory.getAmount(I.BRONZE_DAGGER), 5);
  assert.ok(relic.messages.includes("You note 2 x Logs."), relic.messages.join(" | "));
  assert.ok(relic.messages.includes("You unnote 2 x Bronze dagger."), relic.messages.join(" | "));

  click("Banker's note", "Toggle", relic);
  click("Banker's note", "Activate", relic);
  assert.equal(inventory.getAmount(notedDagger), 5, "Toggle makes every remembered item note");
  assert.equal(inventory.getAmount(I.BRONZE_DAGGER), 0);

  click("Banker's note", "Toggle", relic);
  click("Banker's note", "Activate", relic);
  assert.equal(inventory.getAmount(I.LOGS), 4, "and back makes every remembered item unnote");
  assert.equal(inventory.getAmount(notedLogs), 0);
});

test("Banker's Note treats item 0 (Dwarf remains) as a remembered item, not as none", () => {
  const relic = character("notezero", "league", BANKERS_NOTE_TR, 4);
  relic.getInventory().add(new Item(I.BANKERS_NOTE, 1), false);
  relic.setAttribute("league:bankers-note", { itemId: I.DWARF_REMAINS, mode: "note" });
  click("Banker's note", "Activate", relic);
  assert.notEqual(relic.messages.at(-1), "Use an item on the banker's note first.");
});

test("Clue Compass: STASH units and Falo, the last-read clue's step; it is the item Falo asks for", () => {
  const who = cases(CLUE_COMPASS, 5);
  click("Clue compass", "Teleport", who.relic);
  const labels = menuView(who.relic).entries.map((entry) => entry.label);
  assert.ok(labels.some((text) => /STASH units/.test(text)), labels.join(", "));
  choose("Falo the Bard");
  choose("Falo the Bard");
  assert.deepEqual(at(teleports.at(-1)), [2689, 3550, 0]);

  // A clue read, through the trail's own state; the compass goes where it leads.
  who.relic.getInventory().add(new Item(I.CLUE_SCROLL_EASY_, 1), false);
  const slot = who.relic.getInventory().getSlotForItemId(I.CLUE_SCROLL_EASY_);
  let trail = null;
  Math.random = (() => { let n = 0; return () => ((n += 0.137) % 1); })();
  for (let tries = 0; tries < 30 && !(trail?.step?.location && trail.step.target !== "kill"); tries++) {
    who.relic.getInventory().setItem(slot, new Item(I.CLUE_SCROLL_EASY_, 1));
    trail = TrailRuntime.stateOf(who.relic, slot);
  }
  assert.ok(trail?.step?.location, "an easy step with a place");
  who.relic.setAttribute("treasure-trails:last-read", { tier: trail.tier.name, token: trail.state.token });
  click("Clue compass", "Current-step", who.relic);
  assert.deepEqual(at(teleports.at(-1)), [trail.step.location.x, trail.step.location.y, trail.step.location.z ?? 0]);

  const falo = (player, itemId) => {
    const request = { player, kind: "falo", itemId, waived: false };
    for (const handler of custom["treasure-trails:requirement-waived"]) handler(request);
    return request.waived;
  };
  assert.equal(falo(who.relic, I.CLUE_COMPASS), true);
  assert.equal(falo(who.relic, I.LOGS), false, "not any item (that is Treasure Arbiter)");
  for (const player of others(who)) assert.equal(falo(player, I.CLUE_COMPASS), false, player.getUsername());
});

test("Crystal of memories (Trailblazer Reloaded tier 3 passive): granted on login, Teleport-back to last teleport, cooldown by total level", () => {
  const Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  const Collect = require("../plugins/modes/leaguerelics/Collect.LeagueRelics");
  const TIER3 = { 0: 1, 1: 1, 2: 1 };
  const who = cases(TIER3, 4);
  assert.equal(who.relic.getInventory().getAmount(I.CRYSTAL_OF_ECHOES), 1, "tier 3 unlock grants the crystal at login");
  assert.equal(who.without.getInventory().getAmount(I.CRYSTAL_OF_ECHOES), 0, "below tier 3: none");
  assert.equal(Crystal.cooldownMinutes(who.relic), 6, "starting total level: 6 minute cooldown");

  const went = [];
  const previousTeleport = core.TeleportHandler.teleport;
  core.TeleportHandler.teleport = (player, location, type, warning, onArrival) => {
    went.push([location.getX(), location.getY(), location.getZ()]);
    onArrival?.();
  };
  try {
    for (const handler of custom["teleport:landed"] ?? []) {
      handler({ player: who.relic, from: new Location(3165, 3485, 0), fromInstance: false });
      handler({ player: who.relic, from: new Location(2400, 4400, 0), fromInstance: true });
      handler({ player: who.relic, from: new Location(2900, 4830, 0), fromInstance: false });
    }
    click("Crystal of Echoes", "Teleport-back", who.relic);
    assert.deepEqual(went, [[3165, 3485, 0]], "Grand Exchange, not the instance or essence mine");
    click("Crystal of Echoes", "Teleport-back", who.relic);
    assert.equal(went.length, 1, "cooldown blocks a second Teleport-back");
    assert.match(who.relic.messages.at(-1), /seconds/);
    click("Crystal of Echoes", "Save-memory", who.relic);
    assert.match(who.relic.messages.at(-1), /will no longer remember/);
    click("Crystal of Echoes", "Check-memories", who.relic);
    assert.match(who.relic.messages.at(-1), /Saving is paused/);
    click("Crystal of Echoes", "Save-memory", who.relic);
    assert.match(who.relic.messages.at(-1), /will now remember/);
    who.relic.setAttribute(Crystal.READY_AT_ATTRIBUTE, 0);
    who.relic.getInventory().delete(I.CRYSTAL_OF_ECHOES, 1);
    assert.ok(Collect.owed(who.relic, 4).includes(I.CRYSTAL_OF_ECHOES), "Collect-items reclaims the tier 3 passive crystal");
  } finally {
    core.TeleportHandler.teleport = previousTeleport;
  }

  for (const player of others(who)) {
    const before = player.messages.length;
    click("Crystal of Echoes", "Teleport-back", player);
    assert.equal(player.messages.length, before, `${player.getUsername()}'s crystal does nothing`);
  }
});

test("Crystal of memories saves only while it is carried and Save-memory is on (issue #17)", () => {
  const Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  const player = cases({ 0: 1, 1: 1, 2: 1 }, 4).relic;
  const land = (x, y) => {
    for (const handler of custom["teleport:landed"] ?? []) {
      handler({ player, from: new Location(x, y, 0), fromInstance: false });
    }
  };
  const saved = () => player.getAttribute(Crystal.RECALL_ATTRIBUTE);

  player.setAttribute(Crystal.RECALL_ATTRIBUTE, null);
  player.getInventory().delete(I.CRYSTAL_OF_ECHOES, 1);
  assert.equal(Crystal.carried(player), false);
  land(3200, 3200);
  assert.equal(saved(), null, "a crystal left behind does not remember the teleport");

  player.getBank(0).add(new Item(I.CRYSTAL_OF_ECHOES, 1), false);
  land(3201, 3201);
  assert.equal(saved(), null, "a banked crystal does not remember either");
  player.getBank(0).delete(I.CRYSTAL_OF_ECHOES, 1);

  player.getInventory().add(new Item(I.CRYSTAL_OF_ECHOES, 1), true);
  land(3202, 3202);
  assert.deepEqual(saved(), { x: 3202, y: 3202, z: 0 }, "carried: it remembers");

  click("Crystal of Echoes", "Save-memory", player);
  assert.equal(Crystal.saving(player), false);
  assert.match(player.messages.at(-1), /will no longer remember/);
  player.setAttribute(Crystal.RECALL_ATTRIBUTE, null);
  land(3203, 3203);
  assert.equal(saved(), null, "paused: a new teleport is not remembered");
  click("Crystal of Echoes", "Check-memories", player);
  assert.match(player.messages.at(-1), /Saving is paused/);

  click("Crystal of Echoes", "Save-memory", player);
  assert.equal(Crystal.saving(player), true);
  assert.match(player.messages.at(-1), /will now remember/);
  land(3204, 3204);
  assert.deepEqual(saved(), { x: 3204, y: 3204, z: 0 }, "resumed: it remembers again");
  assert.equal(Crystal.SAVE_ATTRIBUTE, "league:crystal-of-memories-save");
});

test("Crystal of memories remembers God Wars chambers and resumes their private copy (issue #127)", () => {
  const Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  const player = cases({ 0: 1, 1: 1, 2: 1 }, 4).relic;
  const saved = () => player.getAttribute(Crystal.RECALL_ATTRIBUTE);
  const land = (from, fromInstance, fromArea = null) => {
    for (const handler of custom["teleport:landed"] ?? []) {
      handler({ player, from, fromInstance, fromArea });
    }
  };

  // Public Bandos chamber: an ordinary real tile used to be lost because the altar's own teleport
  // did not publish "teleport:landed" at all (regression covered in the God Wars suite).
  player.setAttribute(Crystal.READY_AT_ATTRIBUTE, 0);
  land(new Location(2870, 5360, 2), false);
  assert.deepEqual(saved(), { x: 2870, y: 5360, z: 2 });
  click("Crystal of Echoes", "Teleport-back", player);
  assert.deepEqual(at(teleports.at(-1)), [2870, 5360, 2]);

  // A private chamber's copied tile is mapped back to the real room tile, and Teleport-back asks
  // God Wars to resume that player's parked chamber before falling back to the public tile.
  const faction = { key: "bandos", room: { minX: 2864, maxX: 2877, minY: 5351, maxY: 5373, z: 2 } };
  const area = {
    isGodWarsInstance: true,
    isDestroyed: () => false,
    faction,
    sourceOf: (location) => new Location(location.getX() + 352 * 8, location.getY() + 663 * 8, location.getZ()),
  };
  player.setAttribute(Crystal.RECALL_ATTRIBUTE, null);
  land(new Location(54, 56, 2), true, area);
  assert.deepEqual(saved(), { x: 2870, y: 5360, z: 2, godwars: { faction: "bandos" } });

  let recalled = null;
  const previous = custom["godwars:chamber-recall"] ?? [];
  custom["godwars:chamber-recall"] = [(event) => { recalled = event; event.handled = true; }];
  try {
    player.setAttribute(Crystal.READY_AT_ATTRIBUTE, 0);
    click("Crystal of Echoes", "Teleport-back", player);
    assert.deepEqual(at(teleports.at(-1)), [2870, 5360, 2]);
    assert.equal(recalled.faction, "bandos");
    assert.deepEqual([recalled.location.getX(), recalled.location.getY(), recalled.location.getZ()], [2870, 5360, 2]);
  } finally {
    custom["godwars:chamber-recall"] = previous;
  }

  // A destroyed chamber is not remembered again; the last good memory is left intact.
  player.setAttribute(Crystal.RECALL_ATTRIBUTE, null);
  land(new Location(54, 56, 2), true, { ...area, isDestroyed: () => true });
  assert.equal(saved(), null, "a stale instance never becomes a return target");
});

test("Level-Up World: Trailblazer Reloaded tier 3 unlocks the Crystal of memories passive", () => {
  const Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  const player = character("levelupcrystal", "main");
  const answer = (query) => {
    if (query.player !== player) return;
    query.league = 4;
    query.active = true;
  };
  custom["level-up:relic-profile"] = [answer, ...(custom["level-up:relic-profile"] ?? [])];
  try {
    player.setAttribute("league:relics", { 0: 1, 1: 1 });
    assert.equal(Crystal.unlocked(player), false, "tier 2 only");
    player.setAttribute("league:relics", { 0: 1, 1: 1, 2: 1 });
    assert.equal(Crystal.unlocked(player), true, "tier 3: Level-Up uses the Trailblazer Reloaded catalog");
    player.getInventory().delete(I.CRYSTAL_OF_ECHOES, player.getInventory().getAmount(I.CRYSTAL_OF_ECHOES));
    assert.equal(Crystal.grantCrystal(player), true);
    assert.equal(player.getInventory().getAmount(I.CRYSTAL_OF_ECHOES), 1);
    for (const handler of custom["league:relic-unlocked"] ?? []) {
      handler({ player, league: 4, tier: 2, slot: 1, relic: "bankers-note", levelUp: true });
    }
    assert.equal(player.getInventory().getAmount(I.CRYSTAL_OF_ECHOES), 1, "already held: unlock does not duplicate");
  } finally {
    custom["level-up:relic-profile"] = custom["level-up:relic-profile"].filter((handler) => handler !== answer);
  }
});

test("Crystal of memories: the cooldown follows the listed total-level tiers, is capped while recharging, and clears at 1,800", () => {
  const Crystal = require("../plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics");
  const player = cases({ 0: 1, 1: 1, 2: 1 }, 4).relic;
  const originalManager = player.getSkillManager;
  const originalNow = Date.now;
  const previousTeleport = core.TeleportHandler.teleport;
  const now = 1_800_000_000_000;
  const tiers = [
    [32, 6], [299, 6],
    [300, 5], [599, 5],
    [600, 4], [899, 4],
    [900, 3], [1199, 3],
    [1200, 2], [1499, 2],
    [1500, 1], [1799, 1],
    [1800, 0], [2400, 0],
  ];
  let teleported = 0;
  Date.now = () => now;
  core.TeleportHandler.teleport = (target, location, type, warning, onArrival) => {
    teleported++;
    onArrival?.();
  };
  try {
    player.setAttribute(Crystal.RECALL_ATTRIBUTE, { x: 3222, y: 3218, z: 0 });
    for (const [total, minutes] of tiers) {
      player.getSkillManager = () => ({ getTotalLevel: () => total, getCurrentLevel: () => 10 });
      player.setAttribute(Crystal.READY_AT_ATTRIBUTE, 0);
      click("Crystal of Echoes", "Teleport-back", player);
      assert.equal(Crystal.cooldownMinutes(player), minutes, `${total} total levels`);
      assert.equal(player.getAttribute(Crystal.READY_AT_ATTRIBUTE), minutes > 0 ? now + minutes * 60_000 : 0,
        `${total} total levels: ${minutes} minute cooldown`);
    }
    assert.equal(teleported, tiers.length, "every use without a current cooldown teleports");

    // An existing cooldown cannot outlast the tier the character has reached.
    player.getSkillManager = () => ({ getTotalLevel: () => 600, getCurrentLevel: () => 10 });
    player.setAttribute(Crystal.READY_AT_ATTRIBUTE, now + 6 * 60_000);
    assert.equal(Crystal.cooldownRemainingMs(player, now), 4 * 60_000, "600 total levels cap the running cooldown at four minutes");
    player.getSkillManager = () => ({ getTotalLevel: () => 1800, getCurrentLevel: () => 10 });
    assert.equal(Crystal.cooldownRemainingMs(player, now), 0, "1,800 total levels clear the running cooldown");
    click("Crystal of Echoes", "Teleport-back", player);
    assert.equal(teleported, tiers.length + 1, "the cleared cooldown lets the teleport through");
    assert.equal(player.getAttribute(Crystal.READY_AT_ATTRIBUTE), 0, "no new cooldown at 1,800 total levels");
  } finally {
    Date.now = originalNow;
    core.TeleportHandler.teleport = previousTeleport;
    player.getSkillManager = originalManager;
  }
});

test("Total Recall: Save-memory keeps the place, Hitpoints (up to 127), Prayer and special; Teleport-back sets them back; not in an instance", () => {
  const who = cases(TOTAL_RECALL, 5);
  const relic = who.relic;
  relic.getSkillManager().setCurrentLevel(Skill.PRAYER, 30, false);
  relic.setSpecialPercentage(60);
  relic.moveTo(new Location(3222, 3218, 0));
  click("Crystal of Echoes", "Save-memory", relic);
  relic.moveTo(new Location(3093, 3493, 0));
  relic.setNeedsPlacement(false); // placed, as a tick after the move
  relic.getSkillManager().setCurrentLevel(Skill.PRAYER, 1, false);
  relic.setSpecialPercentage(0);
  click("Crystal of Echoes", "Teleport-back", relic);
  assert.deepEqual(at(teleports.at(-1)), [3222, 3218, 0]);
  assert.equal(relic.getSkillManager().getCurrentLevel(Skill.PRAYER), 30);
  assert.equal(relic.getHitpoints(), 10, "the Hitpoints kept");
  assert.equal(relic.getSpecialPercentage(), 60);
  click("Crystal of Echoes", "Check-memories", relic);
  assert.match(relic.messages.at(-1), /3222, 3218/);
  relic.getPrivateArea = () => ({});
  click("Crystal of Echoes", "Save-memory", relic);
  assert.match(relic.messages.at(-1), /can't remember/);
  for (const player of others(who)) {
    click("Crystal of Echoes", "Save-memory", player);
    assert.equal(player.getAttribute(require("../plugins/modes/leaguerelics/TotalRecall.LeagueRelics").MEMORY_ATTRIBUTE), undefined, player.getUsername());
  }
});

test("Grimoire: the Mage Arena's god spells cast anywhere without their 100 casts", () => {
  const who = cases(GRIMOIRE, 5);
  const godSpell = MageArena._test.GODS[0].spellId;
  const disabled = (player) => {
    const event = { player, spellId: godSpell, disabled: false };
    MageArena._test.spellDisabled(event);
    return event.disabled;
  };
  assert.equal(disabled(who.relic), false);
  for (const player of others(who)) assert.equal(disabled(player), true, player.getUsername());
});

test("Grimoire (Demonic Pacts): choosing it re-sends the prayer book's unlock flags (capture 237/01107)", () => {
  const synced = [];
  const record = ({ player }) => synced.push(player.getUsername());
  custom["prayer:sync-unlocks"] = (custom["prayer:sync-unlocks"] ?? []).concat(record);
  try {
    const pacts = character("pacts", "league", {}, 6);
    const echoes = character("echoes", "league", {}, 5);
    for (const handler of custom["league:relic-unlocked"]) handler({ player: pacts, relic: "grimoire" });
    for (const handler of custom["league:relic-unlocked"]) handler({ player: pacts, relic: "abundance" });
    for (const handler of custom["league:relic-unlocked"]) handler({ player: echoes, relic: "grimoire" });
    assert.deepEqual(synced, ["pacts"], "only Demonic Pacts' Grimoire hands out the prayers");
    for (const handler of custom["league:relics-reset"]) handler({ player: pacts });
    assert.deepEqual(synced, ["pacts", "pacts"], "a relic reset takes them back");
  } finally {
    custom["prayer:sync-unlocks"] = custom["prayer:sync-unlocks"].filter((handler) => handler !== record);
  }
});

test("Guardian horn summons, dismisses, toggles modes and changes outfit", () => {
  const Guardian = require("../plugins/modes/leaguerelics/Guardian.LeagueRelics");
  const player = character("guardian", "league", { 7: 1 }, 5);
  player.getInventory().add(new Item(I.GUARDIAN_HORN, 1), true);

  click("Guardian horn", "Summon", player);
  assert.equal(spawned.length, 1, "Summon spawns one thrall");
  assert.equal(spawned[0].definition.id, Guardian.OUTFITS[0]);
  assert.equal(spawned[0].definition.owner, player);
  assert.equal(spawned[0].definition.ownerOnly, true);
  assert.equal(spawned[0].following, player);
  assert.equal(Guardian.stateOf(player)?.ticks, Guardian.DURATION_TICKS);

  click("Guardian horn", "Summon", player);
  assert.equal(spawned.length, 1, "a second Summon does not stack a second guardian");
  assert.match(player.messages.at(-1), /already here/);

  click("Guardian horn", "Toggle-modes", player);
  assert.equal(Guardian.attacking(player), false);
  click("Guardian horn", "Toggle-modes", player);
  assert.equal(Guardian.attacking(player), true);

  click("Guardian horn", "Change-outfit", player);
  assert.equal(spawned.at(-1).definition.id, Guardian.OUTFITS[1]);
  assert.equal(player.getAttribute(Guardian.OUTFIT_ATTRIBUTE), 1);

  click("Guardian horn", "Dismiss", player);
  assert.equal(Guardian.stateOf(player), null);
  assert.equal(spawned[0].registered, false);
});

test("Reloaded: a second relic of tiers 1 to 3, a different one from the tier's own; its item; only one", () => {
  const relic = character("reloaded", "league", { 0: 1, 1: 1, 2: 1, 3: 2 }, 5);
  const has = (key) => require("../plugins/modes/leaguerelics/Common.LeagueRelics").hasRelic(relic, key);
  assert.equal(has("bank-heist"), false);
  relic.getInventory().resetItems();
  assert.equal(Unlock.unlock(relic, 2, 2, { bankOpen: true }), true, "tier 3's second relic");
  assert.equal(has("bank-heist"), true, "Bank Heist as well as Clue Compass");
  assert.equal(has("clue-compass"), true);
  assert.equal(relic.getInventory().getAmount(I.BANKERS_BRIEFCASE), 1, "with its briefcase");
  assert.equal(Unlock.unlock(relic, 1, 2, { bankOpen: true }), false, "one extra pick only");
  assert.equal(has("dodgy-deals"), false);

  const again = character("reloaded2", "league", { 0: 1, 3: 2 }, 5);
  assert.equal(Unlock.unlock(again, 0, 1, { bankOpen: true }), false, "not the tier's own pick");
  assert.equal(Unlock.unlock(again, 4, 2, { bankOpen: true }), false, "not a tier above 3 (and tier 5 is not chosen)");

  const without = character("noreload", "league", { 0: 1, 2: 1 }, 5);
  assert.equal(Unlock.unlock(without, 2, 2, { bankOpen: true }), false, "without Reloaded: the tier is taken");
  const tr = character("trreload", "league", { 0: 1, 2: 1, 3: 2 }, 4);
  assert.equal(Unlock.unlock(tr, 2, 2, { bankOpen: true }), false, "Trailblazer Reloaded's same slot is not Reloaded");
});

test("Bank Heist: every bank, bank chest and deposit box in the cache's map, named after the nearest place, grouped; only unlocked areas", () => {
  const DATA = require("../plugins/modes/data/league-bank-heist.json");
  assert.ok(DATA.banks.length > 100, "the generated list");
  for (const bank of DATA.banks) assert.ok(["bank", "bank chest", "deposit box"].includes(bank.kind));
  const tiles = new Set(DATA.banks.map((bank) => `${bank.x},${bank.y},${bank.z}`));
  assert.equal(tiles.size, DATA.banks.length, "no bank twice");
  const who = cases(BANK_HEIST, 5);
  click("Banker's briefcase", "Teleport", who.relic);
  const runs = menuView(who.relic).entries.map((entry) => entry.label);
  assert.ok(runs.length >= 2, runs.join(", "));
  const Heist = require("../plugins/modes/leaguerelics/BankHeist.LeagueRelics");
  const list = Heist._test.banks(who.relic);
  assert.equal(list.length, DATA.banks.length, "one destination a bank");
  assert.ok(list.some((bank) => bank.label === "Lumbridge bank"), "Lumbridge's, by its place");
  assert.ok(list.some((bank) => bank.label === "Edgeville bank"));
  const edgeville = list.find((bank) => bank.label === "Edgeville bank");
  choose(Heist._test.groups(who.relic, list).find(([, run]) => run.includes(edgeville))[0]);
  choose("Edgeville bank");
  const [x, y] = at(teleports.at(-1));
  assert.ok(Math.abs(x - edgeville.location.getX()) <= 4 && Math.abs(y - edgeville.location.getY()) <= 4, "at the bank");

  // With the map's clipping: a booth's own tile is solid, and the landing is the customers' side.
  const { RegionManager } = require("../dist/game/collision/RegionManager");
  RegionManager.init();
  const Teleports = require("../plugins/modes/leaguerelics/Teleports.LeagueRelics");
  const draynor = list.find((bank) => bank.label === "Draynor Village bank");
  const landed = Teleports.landing(draynor.location);
  assert.ok(Teleports.reach(landed, 30) >= 30, "open floor to walk from");
  assert.ok(landed.getX() >= 3092, "not behind the counter (the bankers stand west of x 3092)");
  click("Banker's briefcase", "Last-destination", who.relic);
  assert.equal(teleports.length, 2);

  // With the league's areas answering, the banks are grouped by area.
  const area = (query) => {
    if (query.y > 4500) return; // no league area: Other
    query.area = query.x < 3000 ? "kandarin" : "misthalin";
    query.name = query.x < 3000 ? "Kandarin" : "Misthalin";
  };
  custom["league:area-at"] = [area, ...(custom["league:area-at"] ?? [])];
  click("Banker's briefcase", "Teleport", who.relic);
  assert.deepEqual(menuView(who.relic).entries.map((entry) => entry.label), ["Kandarin", "Misthalin", "Other"]);
  const locked = (query) => { query.unlocked = ["misthalin"]; };
  custom["league:areas"] = [locked, ...(custom["league:areas"] ?? [])];
  click("Banker's briefcase", "Teleport", who.relic);
  assert.deepEqual(menuView(who.relic).entries.map((entry) => entry.label), ["Misthalin", "Other"], "a locked area's banks are not offered");
  custom["league:areas"] = custom["league:areas"].filter((handler) => handler !== locked);
  custom["league:area-at"] = custom["league:area-at"].filter((handler) => handler !== area);
  for (const player of others(who)) {
    const before = player.sent.packets.length;
    click("Banker's briefcase", "Teleport", player);
    assert.equal(player.sent.packets.length, before, `${player.getUsername()}'s briefcase does nothing`);
  }
});
