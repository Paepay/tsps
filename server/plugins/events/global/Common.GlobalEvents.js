"use strict";

/**
 * Global Events world state (Paepay/tsps#65, Paepay/PaeScape_Realms#110).
 *
 * A hosted world never invents an activation. It reads the platform's active slots and applies
 * their effect descriptors locally; standalone worlds keep the same state in data/saves for
 * previews. Account opt-outs are scoped to the platform account and event id, matching the
 * platform contract, and are the single gate every effect uses.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const worldData = require("../../persistence/WorldData");
const { getPlatformAccess } = require("../../paescape/PaeScapeBridge");
const DATA = require("./data/global-events.json");

const STORE_KEY = "global-events";
const OPT_OUT_ATTRIBUTE = "global-events:disabled";
const STATE_VERSION = 1;
const TICK_MS = 5000;
const SYNC_MS = Number(DATA.platform?.syncIntervalMs ?? 30000);
const CATEGORIES = Object.freeze(["combat", "skilling", "utility"]);

let api = null;
let storeFile = path.join(process.cwd(), "data", "saves", "global-events.json");
let state = emptyState();
/**
 * False until this world has an authoritative state: its own saved document, or one successful
 * platform answer. Cleanup must not run before that, or a hosted login that beats the first
 * platform poll would read an empty world and delete live loans.
 */
let worldStateKnown = false;
let timer = null;
let syncTimer = null;
let syncPromise = null;
let core = null;
let claimablesProvider = null;
let tokenStatusProvider = null;

function emptyState() {
  return { version: STATE_VERSION, revision: 0, slots: { combat: null, skilling: null, utility: null } };
}

function catalogRows() {
  return Array.isArray(DATA.events) ? DATA.events : [];
}

function definitions() {
  return new Map(catalogRows().map((row) => [row.id, row]));
}

function definition(eventId) {
  return definitions().get(eventId) ?? null;
}

/** Every event row, for the interface and admin commands. */
function catalog() {
  return catalogRows().map((row) => ({ ...row }));
}

function config() {
  return DATA;
}

function platformAccess() {
  try {
    return getPlatformAccess();
  } catch {
    return null;
  }
}

function platformRequest() {
  const access = platformAccess();
  return typeof access?.worldRequest === "function" ? access.worldRequest : null;
}

/** True when this process is talking to the PaeScape platform. */
function hosted() {
  const access = platformAccess();
  return platformRequest() !== null && Boolean(access?.platformOrigin?.());
}

/** The stable platform account id for a character name, when linked. */
function platformUserId(name) {
  const access = platformAccess();
  if (typeof access?.platformUserId !== "function") return null;
  const userId = access.platformUserId(name);
  return userId ? String(userId) : null;
}

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryOf(eventId) {
  return definition(eventId)?.category ?? null;
}

function normalizeSlot(raw, category) {
  if (!raw || typeof raw !== "object") return null;
  const event = definition(raw.eventId);
  if (!event || event.category !== category) return null;
  const instanceId = String(raw.instanceId ?? raw.activationId ?? "");
  if (instanceId.length < 8) return null;
  const ended = Number(raw.endsAt);
  if (!Number.isFinite(ended) || ended <= 0) return null;
  return {
    eventId: event.id,
    instanceId,
    activatedBy: typeof raw.activatedBy === "string" ? raw.activatedBy.slice(0, 40) : "",
    startedAt: Number(raw.startedAt) > 0 ? Number(raw.startedAt) : 0,
    endsAt: Math.floor(ended),
    summary: typeof raw.summary === "string" ? raw.summary : event.summary ?? "",
    description: typeof raw.description === "string" ? raw.description : event.description ?? "",
    effect: raw.effect && typeof raw.effect === "object" ? raw.effect : event.effect ?? null,
  };
}

function normalize(raw) {
  const next = emptyState();
  if (!raw || typeof raw !== "object") return next;
  for (const category of CATEGORIES) {
    next.slots[category] = normalizeSlot(raw.slots?.[category], category);
  }
  next.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  return next;
}

/** The standalone world's document; hosted state always comes from the platform. */
function readState() {
  if (!hosted() && worldData.isHosted()) {
    const source = worldData.read(STORE_KEY);
    if (!source.loaded) return null;
    return normalize(source.value);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(storeFile, "utf8").replace(/^\uFEFF/, ""));
    return normalize(saved);
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    api?.log?.(`GlobalEvents: ${storeFile} is unreadable (${error.message}); no event is active`);
    return null;
  }
}

function writeState(next) {
  if (hosted()) return;
  if (worldData.isHosted()) {
    worldData.write(STORE_KEY, next);
    return;
  }
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(`${storeFile}.tmp`, JSON.stringify(next));
  fs.renameSync(`${storeFile}.tmp`, storeFile);
}

function load() {
  const loaded = readState();
  state = loaded ?? emptyState();
  worldStateKnown = loaded !== null;
  return loaded !== null;
}

/** True once the world's slots are authoritative (saved or read from the platform). */
function stateKnown() {
  return worldStateKnown;
}

function revision() {
  return state.revision;
}

function active(category) {
  expire();
  return CATEGORIES.includes(category) ? state.slots[category] ?? null : null;
}

function activeByEventId(eventId) {
  expire();
  for (const category of CATEGORIES) {
    const slot = state.slots[category];
    if (slot?.eventId === eventId) return slot;
  }
  return null;
}

function activeSlots() {
  expire();
  return CATEGORIES
    .map((category) => ({ category, slot: state.slots[category] }))
    .filter((entry) => entry.slot !== null);
}

/** A stable key for the exact set of live instances; a new activation changes it. */
function activeKey() {
  return activeSlots().map(({ slot }) => slot.instanceId).sort().join(",");
}

/** The most recently started live slot, which the HUD icon represents. */
function newestSlot() {
  return activeSlots()
    .map(({ category, slot }) => ({ category, slot, event: definition(slot.eventId) }))
    .sort((a, b) => b.slot.startedAt - a.slot.startedAt)[0] ?? null;
}

function remainingSeconds(slot, now = Date.now()) {
  if (!slot) return 0;
  return Math.max(0, Math.ceil((slot.endsAt - now) / 1000));
}

/**
 * The countdown text the website's /play page shows (`remainingLabel` in src/pages/play.ts),
 * so the in-game interface and the website read the same: "45s", "5m 12s", "1h 29m", "2d 3h".
 * It is derived from the activation's end time, never from a stored remainder, so it ticks.
 */
function remainingLabel(slotOrEndsAt, now = Date.now()) {
  const endsAt = slotOrEndsAt !== null && typeof slotOrEndsAt === "object" ? slotOrEndsAt.endsAt : slotOrEndsAt;
  const milliseconds = Number(endsAt) - now;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "ending";
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function instanceOf(eventId) {
  return activeByEventId(eventId)?.instanceId ?? null;
}

/** The event's category slot while `instanceId` is still the live one, else null. */
function liveInstance(eventId, instanceId) {
  const slot = activeByEventId(eventId);
  return slot && slot.instanceId === instanceId ? slot : null;
}

/** The platform's current effect parameters for an event, with the frozen catalog as fallback. */
function effectOf(eventId) {
  const slot = activeByEventId(eventId);
  if (slot?.effect && typeof slot.effect === "object") return slot.effect;
  return definition(eventId)?.effect ?? null;
}

function newInstanceId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function changed(kind, detail = {}) {
  api?.emitCustomEvent("global-events:changed", { kind, ...detail, revision: state.revision });
}

/**
 * Start an event on a standalone preview world. A hosted world refuses this: only the platform
 * writes activations, and it checks the slot and token atomically before the world applies the
 * returned state.
 */
function activate(eventId, { actor = "", endsAt = 0, startedAt = Date.now(), instanceId = null } = {}) {
  if (hosted()) return { ok: false, error: "Global Events are activated by the PaeScape platform." };
  const event = definition(eventId);
  if (!event) return { ok: false, error: `Unknown event: ${eventId}` };
  expire();
  const current = state.slots[event.category];
  if (current) return { ok: false, error: `A ${event.category} event is already running.` };
  const ended = Math.floor(Number(endsAt));
  if (!Number.isFinite(ended) || ended <= startedAt) {
    return { ok: false, error: "The event needs a duration before it can start." };
  }
  const slot = {
    eventId: event.id,
    instanceId: instanceId || newInstanceId(),
    activatedBy: String(actor ?? "").slice(0, 40),
    startedAt,
    endsAt: ended,
    summary: event.summary ?? "",
    description: event.description ?? "",
    effect: event.effect ?? null,
  };
  state = { ...state, revision: state.revision + 1, slots: { ...state.slots, [event.category]: slot } };
  try {
    writeState(state);
  } catch (error) {
    state = { ...state, revision: state.revision - 1, slots: { ...state.slots, [event.category]: current } };
    return { ok: false, error: `Could not save the event: ${error.message}` };
  }
  announceStarted(slot, event);
  broadcast();
  changed("started", { category: event.category, slot });
  return { ok: true, slot, event };
}

/** Start an event for a number of minutes (admin command and token activation). */
function activateFor(eventId, minutes, actor = "") {
  const duration = Number(minutes);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "The event needs a positive duration in minutes." };
  }
  const startedAt = Date.now();
  return activate(eventId, { actor, startedAt, endsAt: startedAt + Math.round(duration * 60_000) });
}

/** An activation seen for the first time this recently is still news worth announcing. */
const FRESH_ANNOUNCE_MS = 2 * 60_000;
const announcedInstances = new Set();

/**
 * Tell everyone on this world a global event started, once per activation. The announcement
 * names who activated it, how long it runs and what it does, so players know what changed.
 */
function announceStarted(slot, event) {
  if (!api?.core || !slot || !event) return;
  if (slot.instanceId) {
    if (announcedInstances.has(slot.instanceId)) return;
    announcedInstances.add(slot.instanceId);
    // The set only guards a few minutes of repeat reads; keep it from growing for a long uptime.
    if (announcedInstances.size > 200) announcedInstances.delete(announcedInstances.values().next().value);
  }
  const duration = remainingLabel(slot.endsAt, Number(slot.startedAt) || Date.now());
  const text = message("activated", {
    activator: slot.activatedBy || "A world event",
    event: event.name,
    duration: duration === "ending" ? "a short while" : duration,
    summary: slot.summary || event.summary || "",
  }).trim();
  if (!text) return;
  for (const player of api.core.World.getPlayers()) player?.sendMessage?.(text);
}

function announceEnded(slot) {
  const event = definition(slot?.eventId);
  const text = message("ended", { event: event?.name ?? slot?.eventId ?? "" });
  if (!text) return;
  for (const player of api?.core?.World?.getPlayers?.() ?? []) player?.sendMessage?.(text);
}

/** End one category's event, or every event when category is null. */
function end(category, reason = "ended") {
  if (hosted()) return false;
  const categories = category === null || category === undefined ? CATEGORIES.slice() : [category];
  let endedAny = false;
  let next = state;
  for (const key of categories) {
    const slot = next.slots[key];
    if (!slot) continue;
    endedAny = true;
    const event = definition(slot.eventId);
    next = { ...next, slots: { ...next.slots, [key]: null } };
    if (event) {
      const text = message("ended", { event: event.name });
      for (const player of api?.core?.World?.getPlayers?.() ?? []) player?.sendMessage?.(text);
    }
    // Cleanup is deliberately outside the save: an expired event's items must go even if
    // the world document cannot be written right now.
    api?.emitCustomEvent("global-events:ended", { category: key, slot, reason, event });
  }
  if (!endedAny) return false;
  state = { ...next, revision: state.revision + 1 };
  try {
    writeState(state);
  } catch (error) {
    api?.log?.(`GlobalEvents: could not save the expiry (${error.message})`);
  }
  broadcast();
  changed("ended", { category });
  return true;
}

/**
 * Stop applying anything whose timer has run out. A hosted world must still do this locally at
 * `endsAt` even when the platform has not refreshed yet; it never extends or invents a timer.
 * Cheap and safe to call on any read.
 */
function expire() {
  const now = Date.now();
  let expiredAny = false;
  let next = state;
  for (const category of CATEGORIES) {
    const slot = next.slots[category];
    if (!slot || slot.endsAt > now) continue;
    expiredAny = true;
    const event = definition(slot.eventId);
    next = { ...next, slots: { ...next.slots, [category]: null } };
    const text = message("ended", { event: event?.name ?? slot.eventId });
    for (const player of api?.core?.World?.getPlayers?.() ?? []) player?.sendMessage?.(text);
    // Cleanup is deliberately outside the save: an expired event's items must go even if the
    // world document cannot be written right now.
    api?.emitCustomEvent("global-events:ended", { category, slot, reason: "expired", event });
  }
  if (!expiredAny) return false;
  state = { ...next, revision: state.revision + 1 };
  if (!hosted()) {
    try {
      writeState(state);
    } catch (error) {
      api?.log?.(`GlobalEvents: could not save the expiry (${error.message})`);
    }
  }
  broadcast();
  changed("ended", { category: null, reason: "expired" });
  return true;
}

function tick() {
  expire();
}

function normalizePlatformSlot(raw, category) {
  if (!raw || typeof raw !== "object") return null;
  const event = definition(String(raw.eventId ?? ""));
  if (!event || event.category !== category) return null;
  const instanceId = String(raw.activationId ?? raw.instanceId ?? "");
  const startsAt = parseTime(raw.startsAt) ?? Date.now();
  const endsAt = parseTime(raw.endsAt);
  if (instanceId.length < 8 || endsAt === null || endsAt <= startsAt || endsAt <= Date.now()) return null;
  return {
    eventId: event.id,
    instanceId,
    startedAt: startsAt,
    endsAt,
    activatedBy: String(raw.activator?.displayName ?? raw.activatedBy ?? "").slice(0, 40),
    summary: typeof raw.summary === "string" ? raw.summary : event.summary ?? "",
    description: typeof raw.description === "string" ? raw.description : event.description ?? "",
    effect: raw.effect && typeof raw.effect === "object" ? raw.effect : event.effect ?? null,
  };
}

function slotKey(slot) {
  if (!slot) return "null";
  return `${slot.eventId}:${slot.instanceId}:${slot.startedAt}:${slot.endsAt}`;
}

/**
 * Replace this world's view with the platform's authoritative three-slot state. A removed or
 * replaced activation is cleaned up immediately; a new one is announced once.
 */
function applyPlatformWorld(events, { announce = true, reason = "platform" } = {}) {
  worldStateKnown = true;
  const nextSlots = { combat: null, skilling: null, utility: null };
  for (const category of CATEGORIES) {
    nextSlots[category] = normalizePlatformSlot(events?.[category], category);
  }
  const previous = state.slots;
  const slotsChanged = CATEGORIES.some((category) => slotKey(previous[category]) !== slotKey(nextSlots[category]));
  if (!slotsChanged) {
    tick();
    return { ok: true, changed: false, state };
  }

  state = { ...state, revision: state.revision + 1, slots: nextSlots };
  const ended = [];
  const started = [];
  for (const category of CATEGORIES) {
    const before = previous[category];
    const after = nextSlots[category];
    if (before && (!after || before.instanceId !== after.instanceId)) ended.push(before);
    if (after && (!before || before.instanceId !== after.instanceId)) started.push(after);
  }
  for (const slot of ended) {
    if (announce) announceEnded(slot);
    api?.emitCustomEvent("global-events:ended", {
      category: definition(slot.eventId)?.category ?? null,
      slot,
      reason,
      event: definition(slot.eventId),
    });
  }
  const now = Date.now();
  for (const slot of started) {
    // Syncs that must stay quiet (login, opening the interface) used to swallow an activation
    // they happened to see first. A genuinely new activation is announced by whichever sync
    // sees it first; an old one (a world restart, a late login) stays quiet.
    const fresh = now - slot.startedAt <= FRESH_ANNOUNCE_MS;
    if (announce || fresh) announceStarted(slot, definition(slot.eventId));
  }
  broadcast();
  changed("platform-sync", { reason });
  return { ok: true, changed: true, state };
}

/** Re-read the platform's active world events. Standalone worlds never make this call. */
function syncWorld({ announce = true, reason = "sync" } = {}) {
  if (!hosted()) return Promise.resolve({ ok: true, skipped: true, state });
  if (syncPromise) return syncPromise;
  const request = platformRequest();
  const timeoutMs = Number(DATA.platform?.requestTimeoutMs ?? 10000);
  const worldPath = DATA.platform?.worldPath ?? "/events";
  syncPromise = (async () => {
    try {
      const result = await request(worldPath, { method: "GET", timeoutMs });
      if (!result?.ok || !result.json || typeof result.json.events !== "object") {
        api?.log?.(`GlobalEvents: world refresh failed (${result?.status ?? 0})`);
        return { ok: false, status: result?.status ?? 0, state };
      }
      return applyPlatformWorld(result.json.events, { announce, reason });
    } catch (error) {
      api?.log?.(`GlobalEvents: world refresh failed (${error.message})`);
      return { ok: false, error: "transport", state };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

/* ----------------------------------------------------------- player opt-outs --- */

/** The event ids this account has opted out of. Scope is account x event, as the platform owns it. */
function disabledEvents(player) {
  const saved = player?.getAttribute?.(OPT_OUT_ATTRIBUTE);
  if (!Array.isArray(saved)) return [];
  return [...new Set(saved.filter((value) => typeof value === "string" && definition(value)))];
}

/** Replace the account's opt-out list with the platform's authoritative `disabledEventIds`. */
function applyDisabledEvents(player, eventIds) {
  if (!player?.setAttribute) return [];
  const next = [...new Set((Array.isArray(eventIds) ? eventIds : [])
    .filter((value) => typeof value === "string" && definition(value)))];
  player.setAttribute(OPT_OUT_ATTRIBUTE, next);
  return next;
}

/** Whether the effect of `eventId` applies to this player right now. */
function effectsEnabled(player, eventId) {
  const slot = activeByEventId(eventId);
  if (!slot || !player) return false;
  return !disabledEvents(player).includes(eventId);
}

/**
 * Turn one active event's effects on or off for this player. Standalone worlds keep the choice
 * locally; a hosted world must write it through the platform (Tokens.setPreference) instead,
 * because the platform owns account preferences.
 */
function setEffectsEnabled(player, eventId, enabled) {
  if (hosted()) return { ok: false, error: "Event preferences are managed by the PaeScape platform." };
  const slot = activeByEventId(eventId);
  if (!slot) return { ok: false, error: "That event is not active." };
  const next = disabledEvents(player).filter((value) => value !== eventId);
  if (!enabled) next.push(eventId);
  applyDisabledEvents(player, next);
  api?.emitCustomEvent("global-events:preference-changed", { player, eventId, enabled });
  sendState(player);
  return { ok: true, enabled };
}

/* ------------------------------------------------------------- messaging --- */

function message(key, values = {}) {
  const template = DATA.messages?.[key];
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

/** Command base the in-game Events interface is authorized against (everyone unless restricted). */
const INTERFACE_COMMAND = "events";

/**
 * Whether this player may open the in-game Events interface. It asks the command permission
 * system about the `events` base, so a world.json override and platform-resolved hosted-staff
 * developers behave as they do for every other command, and it fails closed when that system
 * is unavailable.
 */
function mayOpenInterface(player) {
  if (!player || !core) return false;
  try {
    return core.PluginManager?.playerHasCommandRights?.(player, INTERFACE_COMMAND) === true;
  } catch {
    return false;
  }
}

function statePayload(player = null) {
  const now = Date.now();
  const slots = {};
  for (const category of CATEGORIES) {
    const slot = state.slots[category];
    if (!slot) {
      slots[category] = null;
      continue;
    }
    const event = definition(slot.eventId);
    slots[category] = {
      eventId: slot.eventId,
      instanceId: slot.instanceId,
      name: event?.name ?? slot.eventId,
      category,
      medallion: event?.medallion ?? null,
      summary: slot.summary ?? event?.summary ?? "",
      description: slot.description ?? event?.description ?? "",
      activator: slot.activatedBy,
      endsAt: slot.endsAt,
      remainingSeconds: remainingSeconds(slot, now),
      enabled: player ? effectsEnabled(player, slot.eventId) : true,
    };
  }
  const newest = newestSlot();
  return {
    type: "state",
    // The client only draws the HUD button when the server says this player may open it.
    canOpen: player ? mayOpenInterface(player) : false,
    revision: state.revision,
    now,
    activeKey: activeKey(),
    iconItemId: newest?.event?.iconItemId ?? -1,
    iconName: newest?.event?.name ?? "",
    slots,
    claimables: player && claimablesProvider ? claimablesProvider(player) : [],
    tokens: tokenStatusProvider ? tokenStatusProvider(player) : { available: false },
  };
}

function sendPluginMessage(player, payload) {
  if (!player?.getSession || !core) return;
  try {
    player.getSession().sendClientPacket(core.encodePluginMessage("global-events", payload));
  } catch {
    // A disconnecting player is not an error.
  }
}

function sendState(player) {
  sendPluginMessage(player, statePayload(player));
}

/** Tell the client the player has seen the current events; the HUD icon stops flashing. */
function sendSeen(player) {
  sendPluginMessage(player, { type: "seen", activeKey: activeKey(), revision: state.revision });
}

function setClaimablesProvider(provider) {
  claimablesProvider = typeof provider === "function" ? provider : null;
}

function setTokenStatusProvider(provider) {
  tokenStatusProvider = typeof provider === "function" ? provider : null;
}

function broadcast() {
  for (const player of api?.core?.World?.getPlayers?.() ?? []) sendState(player);
  api?.emitCustomEvent("global-events:broadcast", { state: statePayload() });
}

function worldId() {
  try {
    const access = getPlatformAccess();
    const configured = access?.readConfig?.()?.worldId;
    if (configured) return String(configured);
  } catch {
    // Standalone fallback below.
  }
  return String(process.env.PAESCAPE_WORLD_ID ?? "").trim() || "local";
}

/**
 * The stable account identity a temporary item is bound to. A hosted world uses the platform
 * user id so alts on the same account share the binding; a standalone preview falls back to the
 * character name.
 */
function accountOf(player) {
  const name = String(player?.getUsername?.() ?? "");
  const userId = platformUserId(name);
  return userId ? `platform:${userId}` : name;
}

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.persistAttribute(OPT_OUT_ATTRIBUTE, []);
  pluginApi.onServerStartup(() => {
    if (hosted()) {
      // The platform is the only writer of activations. Start from an empty local view and
      // re-read it; never import a stale standalone save over the authoritative slots.
      state = emptyState();
      void syncWorld({ reason: "startup" });
    } else {
      load();
    }
    // Keep the poll registered even if the platform access is published after this plugin:
    // syncWorld() is a no-op until a platform URL exists, then picks up automatically.
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => { void syncWorld({ reason: "poll" }); }, SYNC_MS);
    syncTimer.unref?.();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  });
  pluginApi.onServerShutdown?.(() => {
    if (timer) clearInterval(timer);
    timer = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    expire();
  });
  pluginApi.onPlayerLogin(({ player }) => {
    // Reconnect/login starts from whatever the platform says, not from the last cached view.
    if (hosted()) void syncWorld({ reason: "login", announce: false });
    sendState(player);
  });
}

module.exports = {
  STORE_KEY,
  OPT_OUT_ATTRIBUTE,
  CATEGORIES,
  init,
  config,
  hosted,
  platformUserId,
  catalog,
  definitions,
  definition,
  categoryOf,
  effectOf,
  active,
  activeByEventId,
  activeSlots,
  activeKey,
  newestSlot,
  effectsEnabled,
  setEffectsEnabled,
  disabledEvents,
  applyDisabledEvents,
  instanceOf,
  liveInstance,
  remainingSeconds,
  remainingLabel,
  newInstanceId,
  activate,
  activateFor,
  end,
  expire,
  tick,
  normalizePlatformSlot,
  slotKey,
  applyPlatformWorld,
  syncWorld,
  statePayload,
  mayOpenInterface,
  sendState,
  sendSeen,
  sendPluginMessage,
  setClaimablesProvider,
  setTokenStatusProvider,
  stateKnown,
  broadcast,
  worldId,
  accountOf,
  message,
  revision,
  get state() { return state; },
  testing: {
    setStoreFile(file) { storeFile = file; },
    load,
    reset() { state = emptyState(); worldStateKnown = false; announcedInstances.clear(); },
    setState(raw) { state = normalize(raw); worldStateKnown = true; },
  },
};
