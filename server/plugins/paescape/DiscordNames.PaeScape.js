/**
 * Discord display names for chat.
 *
 * Ticket login records the name Discord shows in the PaeScape guild (nick, else
 * display name, else username). On login the name is broadcast to every client
 * on the "discord-names" plugin channel so the Discord Names client plugin can
 * put it before the in-game name in the chatbox.
 */

"use strict";

const CHANNEL = "discord-names";
const DISCORD_NAME_ATTRIBUTE = "paescape:discord-name";
/** Pending names keyed by account key, held between ticket redeem and login. */
const pendingByAccount = new Map();
/** Live names keyed by account key for players currently online. */
const onlineByAccount = new Map();

let api;
let core;

function accountKey(username) {
  return core.Accounts.key(username);
}

function sanitizeDiscordName(value) {
  const text = String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return text || null;
}

function send(player, data) {
  player.getSession?.()?.sendClientPacket?.(core.encodePluginMessage(CHANNEL, data));
}

function broadcast(data, except) {
  for (const player of core.World.getPlayers()) {
    if (!player || player === except) continue;
    send(player, data);
  }
}

function snapshotEntries() {
  const entries = [];
  for (const [key, discordName] of onlineByAccount) {
    const player = core.World.getPlayerByName?.(key);
    const name = player?.getDisplayName?.() ?? player?.getUsername?.() ?? key;
    entries.push({ name: String(name), discordName });
  }
  return entries;
}

/** Remember a Discord name from ticket redeem until the character finishes login. */
function rememberPending(username, discordName) {
  const clean = sanitizeDiscordName(discordName);
  const key = accountKey(username);
  if (!clean) {
    pendingByAccount.delete(key);
    return;
  }
  pendingByAccount.set(key, clean);
}

function onPlayerLogin({ player }) {
  const key = accountKey(player.getUsername());
  const discordName = pendingByAccount.get(key) ?? null;
  pendingByAccount.delete(key);
  if (discordName) {
    player.setAttribute(DISCORD_NAME_ATTRIBUTE, discordName);
    onlineByAccount.set(key, discordName);
  } else {
    player.setAttribute(DISCORD_NAME_ATTRIBUTE, null);
    onlineByAccount.delete(key);
  }
  // The joiner gets everyone already online; everyone else gets this joiner.
  send(player, { type: "snapshot", entries: snapshotEntries() });
  if (discordName) {
    broadcast(
      { type: "set", name: player.getDisplayName?.() ?? player.getUsername(), discordName },
      player,
    );
  }
}

function onPlayerLeave({ player, username }) {
  const name = player?.getDisplayName?.() ?? player?.getUsername?.() ?? username;
  const key = accountKey(username ?? player?.getUsername?.() ?? "");
  pendingByAccount.delete(key);
  if (!onlineByAccount.delete(key)) return;
  if (player) player.setAttribute?.(DISCORD_NAME_ATTRIBUTE, null);
  broadcast({ type: "clear", name: String(name ?? "") });
}

function onPlayerLogout(event) {
  onPlayerLeave(event);
}

function onPlayerDisconnect(event) {
  onPlayerLeave(event);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.onPlayerLogin(onPlayerLogin);
  pluginApi.onPlayerLogout(onPlayerLogout);
  pluginApi.onPlayerDisconnect(onPlayerDisconnect);
}

module.exports = {
  CHANNEL,
  DISCORD_NAME_ATTRIBUTE,
  attach,
  rememberPending,
  sanitizeDiscordName,
  _test: {
    pendingByAccount,
    onlineByAccount,
    snapshotEntries,
    onPlayerLogin,
    onPlayerLeave,
    reset() {
      pendingByAccount.clear();
      onlineByAccount.clear();
    },
  },
};
