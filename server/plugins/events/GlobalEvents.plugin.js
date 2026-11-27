"use strict";

/**
 * Global Events (Paepay/tsps#65): one world event per category, paid for with event tokens on
 * the website, with an in-game browser and a small flashing HUD icon. Effects live in the five
 * modules under ./global; this file owns the interface, commands and refresh loop.
 *
 * Tokens belong to the player's PaeScape (Discord) account, not to a character or a world, and
 * each activation spends exactly one for good. The platform is the only judge of that; this
 * file only asks and then shows the result.
 */

const Common = require("./global/Common.GlobalEvents");
const Items = require("./global/Items.GlobalEvents");
const Skilling = require("./global/Skilling.GlobalEvents");
const Combat = require("./global/Combat.GlobalEvents");
const Utility = require("./global/Utility.GlobalEvents");
const Tokens = require("./global/Tokens.GlobalEvents");
const Layout = require("./global/Interface.GlobalEvents");

const { GROUP_ID, MAIN_MODAL_UID, TAB, TAB_ORDER, COMPONENT, SPRITE, TAB_UIDS, ROW_UIDS, uid, buildInterface } = Layout;
const TAB_ATTRIBUTE = "global-events:tab";
const SELECTED_ATTRIBUTE = "global-events:selected";
const CLAIM_ROW_START = 100;
/** One "empty slot" row per category on the Live tab, so all three slots are always visible. */
const SLOT_ROW_START = 200;
/** The countdown ticks once a second, like the website's; unchanged data is never resent. */
const REFRESH_MS = 1000;
/** How often an open interface rereads the account's tokens (a website purchase shows up). */
const TOKEN_REFRESH_TICKS = 15;

const SHOW = Object.freeze({
  NONE: Object.freeze([]),
  TOGGLE: Object.freeze([COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL]),
  ACTIVATE: Object.freeze([COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL]),
  CLAIM: Object.freeze([COMPONENT.CLAIM_BUTTON, COMPONENT.CLAIM_LABEL]),
});

const TOKEN_NOTE = "Tokens belong to your Discord account and work on any world. Each activation uses up one token for good.";
const OPT_OUT_NOTE = "The event applies to everyone on this world. Turning it off only affects you, and is saved to your account.";

let api;
let core;
let refreshTimer = null;
let refreshTicks = 0;
/** What each open interface was last sent, so a quiet second sends nothing. */
const lastSent = new WeakMap();

const isOpen = (player) => player?.getInterfaceId?.() === GROUP_ID;

function tabOf(player) {
  const tab = player.getAttribute?.(TAB_ATTRIBUTE);
  return TAB_ORDER.includes(tab) ? tab : TAB.LIVE;
}

function categoryLabel(category) {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** Server text reaches the panel with its markup intact, so a name must not carry any. */
function plain(value) {
  return String(value ?? "").replace(/[<>]/g, "").trim();
}

function ownedTokens(player, eventId) {
  return Tokens.available() && Tokens.linked(player) ? Tokens.quantityFor(player, eventId) : 0;
}

function tokenLine(player, eventId) {
  if (!Tokens.available()) return "Token service unavailable";
  if (!Tokens.linked(player)) return "Link a PaeScape account";
  return `Your tokens: ${Tokens.quantityFor(player, eventId)}`;
}

function tokenSuffix(player, eventId) {
  if (!Tokens.available() || !Tokens.linked(player)) return "";
  const owned = Tokens.quantityFor(player, eventId);
  return owned > 0 ? ` - ${owned} token${owned === 1 ? "" : "s"}` : " - no tokens";
}

/**
 * The event catalog as rows. Each event is one row for every tab it appears in, and its panel
 * always matches its state: a running event offers the player's own on/off switch, a free one
 * offers activation, and one whose category slot is taken by another event offers nothing.
 */
function eventRows(player) {
  return Common.catalog().map((event, index) => {
    const slot = Common.activeByEventId(event.id);
    const category = categoryLabel(event.category);
    const base = {
      id: index + 1,
      eventId: event.id,
      category: event.category,
      name: event.name,
      sprite: SPRITE.ROW[event.category],
      panelSprite: SPRITE.PANEL[event.category],
    };
    if (slot) {
      const enabled = Common.effectsEnabled(player, event.id);
      const label = Common.remainingLabel(slot);
      return {
        ...base,
        detail: ` - Live ${label}${enabled ? "" : " (off)"}`,
        show: SHOW.TOGGLE,
        panel: {
          title: event.name,
          subtitle: `${category} event - Live`,
          info: `Time left: ${label}`,
          info2: `Activated by ${plain(slot.activatedBy) || "a player"}`,
          info3: `Effects for you: ${enabled ? "ON" : "OFF"}`,
          description: `${event.description}<br><br>${OPT_OUT_NOTE}`,
          toggle: enabled ? "Disable for me" : "Enable for me",
        },
      };
    }
    const occupant = Common.active(event.category);
    if (occupant) {
      const occupantName = Common.definition(occupant.eventId)?.name ?? occupant.eventId;
      return {
        ...base,
        detail: " - slot in use",
        show: SHOW.NONE,
        panel: {
          title: event.name,
          subtitle: `${category} event - slot in use`,
          info: `${category} slot: ${plain(occupantName)}`,
          info2: `Free in ${Common.remainingLabel(occupant)}`,
          info3: tokenLine(player, event.id),
          description: `${event.description}<br><br>${TOKEN_NOTE}`,
        },
      };
    }
    const owned = ownedTokens(player, event.id);
    return {
      ...base,
      detail: tokenSuffix(player, event.id),
      show: SHOW.ACTIVATE,
      panel: {
        title: event.name,
        subtitle: `${category} event`,
        info: tokenLine(player, event.id),
        info2: "Costs 1 event token",
        info3: `${category} slot: free`,
        description: `${event.description}<br><br>${TOKEN_NOTE}`,
        activate: owned > 0 ? "Activate (uses 1 token)" : "Activate (no tokens)",
      },
    };
  });
}

/** The three category slots for the Live tab: the running event, or an "empty" row. */
function slotRows(player, events) {
  return Common.CATEGORIES.map((category, index) => {
    const running = events.find((row) => row.category === category && Common.activeByEventId(row.eventId));
    if (running) return running;
    const label = categoryLabel(category);
    return {
      id: SLOT_ROW_START + index,
      category,
      name: `${label} slot`,
      sprite: SPRITE.ROW[category],
      detail: " - empty",
      show: SHOW.NONE,
      panel: {
        title: `${label} slot`,
        subtitle: "No event running",
        info: `No ${category} event is live.`,
        info2: "One can run at a time.",
        info3: "",
        description: `Open the Activate tab to start a ${category} event with an event token, or buy tokens on the website.<br><br>${TOKEN_NOTE}`,
      },
      panelSprite: SPRITE.PANEL[category],
    };
  });
}

/** The temporary items the player can claim right now. */
function claimRows(player) {
  if (!Items?.claimables) return [];
  return Items.claimables(player).map((row, index) => {
    const event = Common.definition(row.eventId);
    return {
      id: CLAIM_ROW_START + index,
      kind: row.kind,
      catalog: row.catalog ?? null,
      name: row.name,
      icon: Number(row.iconItemId ?? row.itemId) || -1,
      detail: row.held ? " (already held)" : " (claim)",
      show: SHOW.CLAIM,
      panel: {
        title: row.name,
        subtitle: "Claimable",
        info: `From: ${event?.name ?? row.eventId}`,
        info2: row.held ? "You already hold this copy." : "Select Claim to receive it.",
        info3: "",
        description: row.kind === Items.KIND.ARSENAL
          ? "A temporary Best-in-Slot copy. It needs no charges, ammo or runes, and cannot leave your account."
          : "A temporary event item. It cannot be traded, banked, sold or kept after the event ends.",
      },
    };
  });
}

/** Each tab's rows in order: the Live slots, the events by category, and the claimable items. */
function tabLayouts(events, slots, claims) {
  const activate = [];
  for (const category of Common.CATEGORIES) {
    const group = events.filter((row) => row.category === category);
    if (!group.length) continue;
    activate.push({ header: categoryLabel(category) }, ...group.map((row) => row.id));
  }
  // The list has no status line, so an empty tab says so itself.
  const claimable = claims.length ? claims.map((row) => row.id) : [{ header: "Nothing to claim right now" }];
  return [slots.map((row) => row.id), activate, claimable];
}

const rowIdsOf = (layout) => layout.filter((entry) => typeof entry === "number");

/**
 * The row the details panel should show for this tab. The player's own pick stays while it is
 * still listed; otherwise the first useful row is chosen so the panel is never empty by
 * accident: a running event on Live, the first event on Activate, the first item on Claimable.
 */
function resolveSelection(player, tab, layout) {
  const ids = rowIdsOf(layout);
  const current = selection(player);
  if (current && current.tab === tab && ids.includes(current.id)) return current.id;
  const id = tab === TAB.LIVE
    ? ids.find((candidate) => candidate < SLOT_ROW_START) ?? ids[0]
    : ids[0];
  player.setAttribute(SELECTED_ATTRIBUTE, id === undefined ? undefined : `${tab}:${id}`);
  return id ?? 0;
}

/**
 * Send the rows and layout, but only what changed since the last send: a countdown changes
 * every second while an event runs, and nothing at all while the interface sits idle.
 * `activeTab` is given on open so the client lands on the player's tab.
 */
function sendRows(player, activeTab = undefined) {
  const events = eventRows(player);
  const slots = slotRows(player, events);
  const claims = claimRows(player);
  const layouts = tabLayouts(events, slots, claims);
  const tab = activeTab ?? tabOf(player);
  const selected = resolveSelection(player, tab, layouts[TAB_ORDER.indexOf(tab)] ?? []);
  // Placeholder rows (an empty slot) are only in the catalog; running events are already in it.
  const data = JSON.stringify([...events, ...slots.filter((row) => row.id >= SLOT_ROW_START), ...claims]);

  const layout = { tabs: layouts };
  if (activeTab !== undefined) layout.active = TAB_ORDER.indexOf(activeTab);
  // `active` only says which tab to land on at open; it is not part of what changed.
  const layoutKey = JSON.stringify(layouts);

  const previous = lastSent.get(player);
  // The client keeps the player's own click; only a change the server made is pushed to it.
  const selectionChanged = !previous || previous.selected !== selected;
  const sender = player.getPacketSender();
  if (!previous || previous.data !== data) sender.sendString(data, uid(COMPONENT.DATA));
  if (selectionChanged || previous.layoutKey !== layoutKey) {
    sender.sendString(JSON.stringify(selectionChanged ? { ...layout, selected } : layout), uid(COMPONENT.LAYOUT));
  }
  lastSent.set(player, { data, layoutKey, selected });
}

function resend(player) {
  lastSent.delete(player);
  sendRows(player);
}

function open({ player, parts = [] }) {
  // ::events is a command with its own rights, but the HUD icon reaches this through the
  // "global-events:open" custom event, which skips the command gate. Re-check here so every
  // route follows the same rights (and fails closed if an operator restricted the command).
  if (!Common.mayOpenInterface(player)) {
    player.sendMessage("You do not have permission to use this command.");
    return true;
  }
  const tab = tabOf(player);
  player.setAttribute(TAB_ATTRIBUTE, tab);
  player.setAttribute(SELECTED_ATTRIBUTE, undefined);
  lastSent.delete(player);
  player.setInterfaceId(GROUP_ID);
  player.getPacketSender().sendSubInterface(MAIN_MODAL_UID, GROUP_ID, 0, {
    postScripts: [{ scriptId: 227, args: [uid(COMPONENT.FRAME), "Global Events"] }],
  });
  sendRows(player, tab);
  // Both ::events and the HUD icon open this way, so this marks every route as seen.
  Common.sendSeen(player);
  void refreshTokens(player);
  if (Common.hosted()) {
    // Never show the interface from a cached view: reread the account preferences and the
    // authoritative three-slot world state first.
    void Tokens.refreshAccount(player).then(() => {
      if (isOpen(player)) sendRows(player);
    });
    void Common.syncWorld({ reason: "ui", announce: false }).then(() => {
      if (isOpen(player)) sendRows(player);
    });
  }
  return true;
}

async function refreshTokens(player) {
  const result = await Tokens.refresh(player);
  if (result?.ok && isOpen(player)) sendRows(player);
  return result;
}

function clickTab({ player, buttonId }) {
  const index = TAB_UIDS.indexOf(buttonId);
  if (index < 0 || !isOpen(player)) return false;
  player.setAttribute(TAB_ATTRIBUTE, TAB_ORDER[index]);
  player.setAttribute(SELECTED_ATTRIBUTE, undefined);
  // The client already switched tabs; tell it which row to show there.
  lastSent.delete(player);
  sendRows(player);
  return true;
}

function clickRow({ player, slot }) {
  if (!isOpen(player)) return false;
  const tab = tabOf(player);
  const id = Number(slot);
  if (!Number.isInteger(id) || id <= 0) return true;
  const events = eventRows(player);
  const layouts = tabLayouts(events, slotRows(player, events), claimRows(player));
  if (!rowIdsOf(layouts[TAB_ORDER.indexOf(tab)]).includes(id)) return true;
  player.setAttribute(SELECTED_ATTRIBUTE, `${tab}:${id}`);
  // The client showed this row the moment it was clicked; remember that so a refresh does
  // not push the same selection back at it.
  const previous = lastSent.get(player);
  if (previous) lastSent.set(player, { ...previous, selected: id });
  return true;
}

function selection(player) {
  const value = player.getAttribute?.(SELECTED_ATTRIBUTE);
  if (typeof value !== "string") return null;
  const [tab, rawId] = value.split(":");
  const id = Number(rawId);
  if (!TAB_ORDER.includes(tab) || !Number.isInteger(id)) return null;
  return { tab, id };
}

/** The catalog event behind the selected row, on any tab that lists events. */
function selectedEvent(player) {
  const selected = selection(player);
  if (!selected || selected.tab === TAB.CLAIMABLE) return null;
  return Common.catalog()[selected.id - 1] ?? null;
}

function toggleSelected({ player }) {
  if (!isOpen(player)) return false;
  const event = selectedEvent(player);
  if (!event) {
    player.sendMessage("Select a live event first.");
    return true;
  }
  const slot = Common.activeByEventId(event.id);
  if (!slot) {
    player.sendMessage("That event is no longer active.");
    resend(player);
    return true;
  }
  const enabled = !Common.effectsEnabled(player, event.id);
  if (Common.hosted()) {
    // The platform owns account x event preferences; write the opt-out and re-render from the
    // authoritative `disabledEventIds` it returns.
    void Tokens.setPreference(player, event.id, !enabled).then(() => {
      if (isOpen(player)) sendRows(player);
    });
    return true;
  }
  Common.setEffectsEnabled(player, event.id, enabled);
  sendRows(player);
  return true;
}

function claimSelected({ player }) {
  if (!isOpen(player)) return false;
  const selected = selection(player);
  if (!selected || selected.tab !== TAB.CLAIMABLE) {
    player.sendMessage("Select a temporary item to claim first.");
    return true;
  }
  const row = claimRows(player)[selected.id - CLAIM_ROW_START];
  if (!row) {
    player.sendMessage("That item is no longer claimable.");
    resend(player);
    return true;
  }
  Items.claim(player, row.kind, row.catalog ?? null);
  sendRows(player);
  Common.sendState(player);
  return true;
}

/**
 * Activate the selected event. The client never decides whether the player may: no inventory
 * item or local token count is required, and the platform is the only judge of token ownership
 * (402 no token, 409 category busy, 403 not a member). Any event selection on the Live or
 * Activate tab qualifies. The activation announcement comes from the world state the platform
 * returns, so it reads the same however the event was started.
 */
function activateSelected({ player }) {
  if (!isOpen(player)) return false;
  const event = selectedEvent(player);
  if (!event) {
    player.sendMessage("Select an event first.");
    return true;
  }
  void Tokens.activate(player, event.id)
    .finally(() => {
      sendRows(player);
      void refreshTokens(player);
    });
  return true;
}

function refreshOpenInterfaces() {
  refreshTicks += 1;
  const reread = refreshTicks % TOKEN_REFRESH_TICKS === 0;
  for (const player of api?.core?.World?.getPlayers?.() ?? []) {
    if (!isOpen(player)) continue;
    sendRows(player);
    if (reread && Common.hosted()) void refreshTokens(player);
  }
}

function globalEventCommand({ player, parts = [] }) {
  const sub = String(parts[1] ?? "list").toLowerCase();
  if (sub === "list") {
    player.sendMessage("Global Events:");
    for (const event of Common.catalog()) {
      const slot = Common.activeByEventId(event.id);
      player.sendMessage(`  ${event.id} [${event.category}] - ${event.name}${slot ? ` (active, ${Common.remainingLabel(slot)})` : ""}`);
    }
    return true;
  }
  if (sub === "start") {
    if (Common.hosted()) {
      player.sendMessage(Common.message("adminPlatformOnly"));
      return true;
    }
    const id = String(parts[2] ?? "").toLowerCase();
    const minutes = Number(parts[3]);
    const event = Common.definition(id);
    if (!event) {
      player.sendMessage(Common.message("adminUnknown", { event: id || "(none)" }));
      return true;
    }
    const result = Common.activateFor(id, minutes, Common.accountOf(player));
    player.sendMessage(result.ok
      ? Common.message("adminStarted", { event: event.name, minutes })
      : result.error);
    return true;
  }
  if (sub === "stop") {
    if (Common.hosted()) {
      player.sendMessage(Common.message("adminPlatformOnly"));
      return true;
    }
    const category = parts[2] ? String(parts[2]).toLowerCase() : null;
    if (category !== null && !Common.CATEGORIES.includes(category)) {
      player.sendMessage(Common.message("adminUsage"));
      return true;
    }
    const stopped = Common.end(category);
    player.sendMessage(category === null
      ? Common.message("adminStoppedAll")
      : stopped ? Common.message("adminStopped", { category }) : `No ${category} event is active.`);
    return true;
  }
  player.sendMessage(Common.message("adminUsage"));
  return true;
}

function register(pluginApi) {
  api = pluginApi;
  core = api.core;
  Common.init(api);
  Items.attach(api);
  Skilling.attach(api);
  Combat.attach(api);
  Utility.attach(api);
  Tokens.attach(api);

  api.registerCustomInterface(buildInterface());
  api.persistAttribute(TAB_ATTRIBUTE, TAB.LIVE);
  // Every player may open the Events interface (the HUD icon, which the client's "Global Events"
  // plugin can hide, and ::events). An operator can still restrict it with a world.json command
  // override: `mayOpenInterface` asks the same command-rights system, so every route follows.
  // Managing events (::globalevent) stays Developer-only.
  api.registerCommand("events", open, core.PlayerRights.NONE, "Browse live Global Events, claim temporary items and spend event tokens");
  api.registerCommand("globalevent", globalEventCommand, core.PlayerRights.DEVELOPER, "Developer: manage Global Events: list | start <event-id> <minutes> | stop [combat|skilling|utility]");
  api.onCustomEvent("global-events:open", open);
  api.onCustomEvent("global-events:changed", () => refreshOpenInterfaces());
  api.onCustomEvent("global-events:ui-refresh", ({ player }) => {
    if (player && isOpen(player)) sendRows(player);
  });
  api.onPlayerLogin(({ player }) => {
    // Login/reconnect re-reads the platform's account state; Common re-reads the world state.
    if (!Common.hosted()) return;
    void Tokens.refreshAccount(player).then(() => {
      if (isOpen(player)) sendRows(player);
    });
  });
  api.onInterfaceActionButton(TAB_UIDS, clickTab);
  api.onInterfaceActionButton(ROW_UIDS, clickRow);
  api.onInterfaceActionButton([uid(COMPONENT.TOGGLE_BUTTON), uid(COMPONENT.TOGGLE_LABEL)], toggleSelected);
  api.onInterfaceActionButton([uid(COMPONENT.CLAIM_BUTTON), uid(COMPONENT.CLAIM_LABEL)], claimSelected);
  api.onInterfaceActionButton([uid(COMPONENT.ACTIVATE_BUTTON), uid(COMPONENT.ACTIVATE_LABEL)], activateSelected);

  api.onServerStartup(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshOpenInterfaces, REFRESH_MS);
    refreshTimer.unref?.();
  });
  api.onServerShutdown?.(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  });
}

module.exports = {
  name: "GlobalEvents",
  description: "World-wide combat, skilling and utility events with an Events interface, temporary items and event tokens.",
  register,
  _test: {
    GROUP_ID, TAB, TAB_ORDER, TAB_ATTRIBUTE, SELECTED_ATTRIBUTE, COMPONENT, SPRITE, uid,
    TAB_UIDS, ROW_UIDS, SLOT_ROW_START, CLAIM_ROW_START, SHOW,
    eventRows, slotRows, claimRows, tabLayouts, selection, globalEventCommand,
  },
};
