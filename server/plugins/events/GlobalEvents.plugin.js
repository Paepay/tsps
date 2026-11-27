"use strict";

/**
 * Global Events (Paepay/tsps#65): one world event per category, paid for with event tokens on
 * the website, with an in-game browser and a small flashing HUD icon. Effects live in the five
 * modules under ./global; this file owns the interface, commands and refresh loop.
 */

const Common = require("./global/Common.GlobalEvents");
const Items = require("./global/Items.GlobalEvents");
const Skilling = require("./global/Skilling.GlobalEvents");
const Combat = require("./global/Combat.GlobalEvents");
const Utility = require("./global/Utility.GlobalEvents");
const Tokens = require("./global/Tokens.GlobalEvents");
const Layout = require("./global/Interface.GlobalEvents");

const { GROUP_ID, MAIN_MODAL_UID, TAB, TAB_ORDER, TAB_LABELS, COMPONENT, TAB_UIDS, ROW_UIDS, uid, buildInterface } = Layout;
const TAB_ATTRIBUTE = "global-events:tab";
const SELECTED_ATTRIBUTE = "global-events:selected";
const CLAIM_ROW_START = 100;
const REFRESH_MS = 5000;

let api;
let core;
let refreshTimer = null;

const isOpen = (player) => player?.getInterfaceId?.() === GROUP_ID;

function tabOf(player) {
  const tab = player.getAttribute?.(TAB_ATTRIBUTE);
  return TAB_ORDER.includes(tab) ? tab : TAB.ACTIVE;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function categoryLabel(category) {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function ownedTokens(player, eventId) {
  return Tokens.available() && Tokens.linked(player) ? Tokens.quantityFor(player, eventId) : 0;
}

function tokenInfo(player, eventId = null) {
  if (!Tokens.available()) return "Token service unavailable";
  if (!Tokens.linked(player)) return "Link a PaeScape account to use event tokens";
  if (!eventId) {
    const paepoints = Tokens.paepointsBalance(player);
    return paepoints === null ? "Token balance: checking..." : `PaePoints: ${paepoints}`;
  }
  return `Event tokens: ${Tokens.quantityFor(player, eventId)}`;
}

/** The event catalog as rows, plus each row's current details-panel text. */
function eventRows(player) {
  return Common.catalog().map((event, index) => {
    const slot = Common.activeByEventId(event.id);
    const enabled = slot ? Common.effectsEnabled(player, event.id) : false;
    const active = slot !== null;
    const owned = ownedTokens(player, event.id);
    const detail = active
      ? ` (${enabled ? "on" : "off"}, ${formatTime(Common.remainingSeconds(slot))})`
      : ` (${categoryLabel(event.category)}${owned > 0 ? `, ${owned} token${owned === 1 ? "" : "s"}` : ""})`;
    return {
      id: index + 1,
      eventId: event.id,
      category: event.category,
      name: event.name,
      icon: Number(event.iconItemId) || -1,
      detail,
      panel: {
        title: event.name,
        subtitle: `${categoryLabel(event.category)} event${active ? " - active" : ""}`,
        info: active ? `Time left: ${formatTime(Common.remainingSeconds(slot))}` : tokenInfo(player, event.id),
        info2: active
          ? `Effects: ${enabled ? "on" : "off"}${slot.activatedBy ? ` - by ${slot.activatedBy}` : ""}`
          : owned > 0
            ? "Select Activate to spend one token. No item is needed."
            : "No token yet: buy one with PaePoints in the website Store.",
        description: event.description,
      },
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
      panel: {
        title: row.name,
        subtitle: "Claimable",
        info: `From: ${event?.name ?? row.eventId}`,
        info2: row.held ? "You already hold this temporary copy." : "Select Claim to receive it.",
        description: row.kind === Items.KIND.ARSENAL
          ? "A temporary Best-in-Slot copy. It needs no charges, ammo or runes, and cannot leave your account."
          : "A temporary event item. It cannot be traded, banked, sold or kept after the event ends.",
      },
    };
  });
}

function sendRows(player, activeTab = undefined) {
  const events = eventRows(player);
  const claims = claimRows(player);
  const activeIds = events.filter((row) => Common.activeByEventId(row.eventId)).map((row) => row.id);
  const layouts = [activeIds, claims.map((row) => row.id), events.map((row) => row.id)];
  const layout = { tabs: layouts };
  if (activeTab !== undefined) layout.active = TAB_ORDER.indexOf(activeTab);
  const sender = player.getPacketSender();
  sender.sendString(JSON.stringify([...events, ...claims]), uid(COMPONENT.DATA));
  sender.sendString(JSON.stringify(layout), uid(COMPONENT.LAYOUT));
}

function open({ player, parts = [] }) {
  const tab = tabOf(player);
  player.setAttribute(TAB_ATTRIBUTE, tab);
  player.setAttribute(SELECTED_ATTRIBUTE, undefined);
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
  if (TAB_ORDER[index] === TAB.TOKENS) void refreshTokens(player);
  return true;
}

function clickRow({ player, slot }) {
  if (!isOpen(player)) return false;
  const tab = tabOf(player);
  const id = Number(slot);
  if (!Number.isInteger(id) || id <= 0) return true;
  if (tab === TAB.CLAIMABLE && (id < CLAIM_ROW_START || id >= CLAIM_ROW_START + claimRows(player).length)) return true;
  if (tab !== TAB.CLAIMABLE && (id < 1 || id > Common.catalog().length)) return true;
  player.setAttribute(SELECTED_ATTRIBUTE, `${tab}:${id}`);
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

function selectedEvent(player, expectedTab) {
  const selected = selection(player);
  if (!selected || selected.tab !== expectedTab) return null;
  return Common.catalog()[selected.id - 1] ?? null;
}

function toggleSelected({ player }) {
  if (!isOpen(player)) return false;
  const event = selectedEvent(player, TAB.ACTIVE);
  if (!event) {
    player.sendMessage("Select an active event first.");
    return true;
  }
  const slot = Common.activeByEventId(event.id);
  if (!slot) {
    player.sendMessage("That event is no longer active.");
    sendRows(player);
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
    sendRows(player);
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
 * (402 no token, 409 category busy, 403 not a member). Any non-claim tab selection qualifies.
 */
function activateSelected({ player }) {
  if (!isOpen(player)) return false;
  const selected = selection(player);
  const event = selected && selected.tab !== TAB.CLAIMABLE ? Common.catalog()[selected.id - 1] ?? null : null;
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
  for (const player of api?.core?.World?.getPlayers?.() ?? []) {
    if (isOpen(player)) sendRows(player);
  }
}

function globalEventCommand({ player, parts = [] }) {
  const sub = String(parts[1] ?? "list").toLowerCase();
  if (sub === "list") {
    player.sendMessage("Global Events:");
    for (const event of Common.catalog()) {
      const slot = Common.activeByEventId(event.id);
      player.sendMessage(`  ${event.id} [${event.category}] - ${event.name}${slot ? ` (active, ${formatTime(Common.remainingSeconds(slot))})` : ""}`);
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
  api.persistAttribute(TAB_ATTRIBUTE, TAB.ACTIVE);
  api.registerCommand("events", open, core.PlayerRights.NONE, "Browse active Global Events, claim temporary items and spend event tokens");
  api.registerCommand("globalevent", globalEventCommand, core.PlayerRights.OWNER, "Manage Global Events: list | start <event-id> <minutes> | stop [combat|skilling|utility]");
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
    GROUP_ID, TAB, TAB_ORDER, TAB_ATTRIBUTE, SELECTED_ATTRIBUTE, COMPONENT, uid,
    TAB_UIDS, ROW_UIDS, formatTime, eventRows, claimRows, selection, globalEventCommand,
  },
};
