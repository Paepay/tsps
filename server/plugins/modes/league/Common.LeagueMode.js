/**
 * Shared by the LeagueMode units: the data, which league a player's profile is in, and the
 * league's rates. A league character is the account's separate save a league world logs it
 * into (`player.getProfile() === "league"`, docs/leagues.md); a main character is never in a
 * league, whatever attributes it carries.
 */
const fs = require("fs");
const path = require("path");
const Relics = require("../leaguerelics/Common.LeagueRelics");

/** Which league the profile joined, set on its first login (a league type, 1-6: enum 2670 in the cache, data/leagues.json). */
const LEAGUE_TYPE_ATTRIBUTE = "league:type";
const LEAGUE_PROFILE = "league";
/** world.json pluginConfig key naming the league this world runs (4 Trailblazer Reloaded, 5 Raging Echoes); absent on a plain world. */
const LEAGUE_TYPE_CONFIG = "league:type";

let api = null;
let core = null;
let data = null;
/** The one-off task `later` submits, defined once api.core.Task is reachable (as Notifications does). */
let LaterTask = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  if (core?.Task) LaterTask = class extends core.Task {
    constructor(ticks, action) {
      // Not keyed to the player: a click must not cancel it.
      super(ticks);
      this.action = action;
    }

    execute() {
      this.stop();
      this.action();
    }
  };
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "leagues.json"), "utf8"));
  // A world whose plugin config names a league runs it: every login is the league character.
  if (worldLeague() !== null) api.setWorldProfile(LEAGUE_PROFILE);
}

/** The league this world runs (pluginConfig `league:type`), or null for a plain world. */
function worldLeague() {
  const type = Number(api.getPluginConfig(LEAGUE_TYPE_CONFIG, 0));
  return data.leagues[type] ? type : null;
}

function isLeagueProfile(player) {
  return player?.getProfile?.() === LEAGUE_PROFILE;
}

/** The league a player is in (its type), or null for a main character or an unknown league. */
function leagueOf(player) {
  if (!isLeagueProfile(player)) return null;
  const type = Number(player.getAttribute?.(LEAGUE_TYPE_ATTRIBUTE));
  return data.leagues[type] ? type : null;
}

function league(type) {
  return data.leagues[type] ?? null;
}

/** A league's tier passives (leagues.json `passives`, by key; Passives.LeagueMode.js applies them). */
function passives(type) {
  return league(type)?.passives ?? {};
}

/** The league a new league character joins: the world's, or the data's default if the config named a type the data does not know. */
function configuredType() {
  return worldLeague() ?? Number(data.default);
}

/** The highest relic tier (0-based) the player has unlocked, or -1; LeagueRelics answers. */
function highestTier(player) {
  const query = { player, tier: -1 };
  api.emitCustomEvent("league:highest-tier", query);
  return Number.isInteger(query.tier) ? query.tier : -1;
}

/** The profile's XP rate: the league's base, raised by the relic tiers reached (Wiki tier passives). */
function xpMultiplier(player) {
  const type = leagueOf(player) ?? Relics.leagueOf(player);
  if (type === null) return 1;
  const { base, fromTier } = league(type).xpMultiplier;
  if (Relics.passivesWorldState().custom) {
    const configured = Relics.activePassiveValues(player, "xpRate", type)
      .map((passive) => Number(passive.effect.multiplier) || 0);
    return Math.max(base, ...configured);
  }
  const tier = highestTier(player);
  let rate = base;
  for (const [from, value] of Object.entries(fromTier ?? {})) {
    if (tier >= Number(from) - 1) rate = Math.max(rate, value);
  }
  return rate;
}

/** The client's date varbit: whole days since 27 February 2002 (data.runedayEpoch). */
function runeday(now = Date.now()) {
  return Math.floor((now - Date.parse(data.runedayEpoch)) / 86400000);
}

function message(key, values = {}) {
  return data.messages[key].text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

/** Runs `action` after `ticks` ticks if the player is still online. */
function later(player, ticks, action) {
  const manager = api.getTaskManager?.();
  if (!LaterTask || typeof manager?.submit !== "function") return;
  manager.submit(new LaterTask(ticks, () => {
    if (player.isRegistered?.() !== false) action();
  }));
}

function bankHasRoom(player, itemId) {
  const container = player.getBank(core.Bank.getTabForItem(player, itemId));
  return container.getFreeSlots() > 0 || container.contains(itemId);
}

/** Puts an item straight in the bank, a note as its item, when it has room; false leaves it to the caller. */
function bank(player, itemId, amount) {
  const id = core.ItemDefinition.forId(itemId)?.unNote?.() ?? itemId;
  if (amount <= 0 || !bankHasRoom(player, id)) return false;
  player.getBank(core.Bank.getTabForItem(player, id)).add(new core.Item(id, amount), true);
  return true;
}

/** The item's noted form, or the item itself when it has none (or is a note already). */
function noted(itemId) {
  const definition = core.ItemDefinition.forId(itemId);
  if (definition?.isNoted?.()) return itemId;
  const note = definition?.getNoteId?.() ?? -1;
  return note > 0 ? note : itemId;
}

module.exports = {
  init, later, isLeagueProfile, leagueOf, league, passives, worldLeague, configuredType, highestTier, xpMultiplier, runeday, message,
  bankHasRoom, bank, noted,
  LEAGUE_TYPE_ATTRIBUTE, LEAGUE_PROFILE, LEAGUE_TYPE_CONFIG,
  get data() { return data; },
  get api() { return api; },
  get core() { return core; },
};
