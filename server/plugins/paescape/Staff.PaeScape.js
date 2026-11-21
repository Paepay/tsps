"use strict";

/**
 * Hosted-world staff support for issue #80.
 *
 * The platform is the authority for who is Host/Admin/Moderator/Developer.
 * This module applies that rank to a logged-in character, executes the real
 * punishment/logout paths a staff console asks for, and keeps a local pending
 * rank for characters that are offline at the moment of a change.
 *
 * It never trusts a browser: the only caller is the platform's Ed25519-signed
 * control request. Every command body is still checked against the same
 * hierarchy and matrix before any in-game action runs.
 */

const { Accounts } = require("../../src/main/typescript/elvarg/game/entity/impl/player/Accounts");
const { GameConstants } = require("../../src/main/typescript/elvarg/game/GameConstants");
const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");

const RANK = { player: 0, moderator: 1, admin: 2, host: 3, developer: 4 };
const RIGHTS = {
  player: PlayerRights.NONE,
  moderator: PlayerRights.MODERATOR,
  admin: PlayerRights.ADMINISTRATOR,
  host: PlayerRights.OWNER,
  developer: PlayerRights.DEVELOPER,
};
const COMMANDS = {
  player: new Set(),
  moderator: new Set(["mute", "unmute", "kick"]),
  admin: new Set(["mute", "unmute", "kick", "ban", "unban"]),
  host: new Set(["mute", "unmute", "kick", "ban", "unban", "ipmute", "unipmute", "ipban", "unipban"]),
  developer: null,
};
const PUNISH = new Set(["mute", "unmute", "ban", "unban"]);
const MAX_RESULTS = 25;
const MAX_PREVIEW_RESULTS = 500;

function roleOf(value) {
  const role = String(value ?? "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANK, role) ? role : "player";
}

function key(name) {
  return Accounts.key(String(name ?? ""));
}

function normaliseName(name) {
  return String(name ?? "").trim().replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 12);
}

function onlinePlayers(api) {
  try {
    const players = api?.core?.World?.getPlayers?.();
    if (!players) return [];
    if (typeof players.stream === "function") return [...players.stream()];
    if (typeof players[Symbol.iterator] === "function") return [...players];
    return [];
  } catch {
    return [];
  }
}

function onlineByName(api, name) {
  try {
    const candidate = api?.core?.World?.getPlayerByName?.(name);
    return candidate && candidate.isPlayerBot?.() !== true ? candidate : null;
  } catch {
    return null;
  }
}

function reverseUserId(userAccounts, name) {
  const wanted = key(name);
  for (const [userId, accountKey] of Object.entries(userAccounts ?? {})) {
    if (accountKey === wanted) return userId;
  }
  return null;
}

function applyRole(player, roleValue, userId) {
  if (!player) return;
  const role = roleOf(roleValue);
  if (userId) player.paeScapeStaffUserId = String(userId);
  if (role === "player") {
    delete player.paeScapeStaff;
    player.setRights(PlayerRights.NONE);
    return;
  }
  player.paeScapeStaff = { role, commands: COMMANDS[role], userId: userId ? String(userId) : null };
  player.setRights(RIGHTS[role]);
}

class StaffController {
  constructor(options) {
    this.api = options.api;
    this.getHosted = options.getHosted;
    this.getUserAccounts = options.getUserAccounts;
    this.bindUserAccount = options.bindUserAccount;
    this.getPunishment = options.getPunishment ?? (() => this.api.getPlayerPunishment?.());
    this.getPersistence = options.getPersistence ?? (() => GameConstants.PLAYER_PERSISTENCE);
    this.pending = new Map();
  }

  setApi(api) {
    this.api = api;
  }

  /** Remember the rank a ticket supplied for this character and apply() it if online. */
  remember(characterName, userId, staffRole) {
    const name = normaliseName(characterName);
    if (!name) return;
    const entry = { userId: userId ? String(userId) : null, role: roleOf(staffRole) };
    this.pending.set(key(name), entry);
    if (entry.userId) this.bindUserAccount(entry.userId, name);
    const online = onlineByName(this.api, name);
    if (online) applyRole(online, entry.role, entry.userId);
  }

  /** Apply the platform rank after the player object exists. Hosted worlds only. */
  onLogin(player) {
    if (!this.getHosted() || !player) return;
    const name = normaliseName(player.getUsername?.() ?? "");
    if (!name) return;
    const entry = this.pending.get(key(name));
    if (entry) {
      applyRole(player, entry.role, entry.userId);
      return;
    }
    // A hosted character without a ticket rank is a Player. Never inherit local
    // rights from an older save on the shared world.
    applyRole(player, "player", player.paeScapeStaffUserId);
  }

  lookup(query) {
    const term = String(query ?? "").trim().toLowerCase();
    const preview = term.length === 0;
    if (!preview && term.length < 2) return { status: 200, body: { ok: true, players: [] } };
    const rows = [];
    const limit = preview ? MAX_PREVIEW_RESULTS : MAX_RESULTS;
    const punishment = this.getPunishment();
    for (const player of onlinePlayers(this.api)) {
      if (player?.isPlayerBot?.() === true) continue;
      const name = String(player?.getUsername?.() ?? "");
      if (!name || (!preview && !name.toLowerCase().includes(term))) continue;
      const skills = player.getSkillManager?.();
      rows.push({
        name,
        online: true,
        userId: player.paeScapeStaffUserId ?? reverseUserId(this.getUserAccounts(), name),
        rights: player.getRights?.().getId?.() ?? 0,
        staffRole: player.paeScapeStaff?.role ?? "player",
        combat: skills?.getCombatLevel?.() ?? null,
        total: skills?.getTotalLevel?.() ?? null,
        banned: punishment?.banned?.(key(name)) ?? false,
        muted: punishment?.muted?.(key(name)) ?? false,
      });
      if (rows.length >= limit) break;
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    if (!rows.length && !preview) {
      const persistence = this.getPersistence();
      try {
        if (persistence && persistence.exists?.(term, GameConstants.WORLD_PROFILE)) {
          rows.push({
            name: term,
            online: false,
            userId: reverseUserId(this.getUserAccounts(), term),
            rights: 0,
            staffRole: "player",
            combat: null,
            total: null,
            banned: punishment?.banned?.(key(term)) ?? false,
            muted: punishment?.muted?.(key(term)) ?? false,
          });
        }
      } catch {
        /* lookup is read-only: an unavailable platform returns online rows only */
      }
    }
    return { status: 200, body: { ok: true, players: rows, preview } };
  }

  async command(body) {
    const action = String(body?.action ?? "").toLowerCase();
    const actorUserId = String(body?.actorUserId ?? "");
    const actorRole = roleOf(body?.actorRole);
    const targetRole = roleOf(body?.targetRole);
    const target = body?.target ?? {};
    const name = normaliseName(target.name);
    if (!PUNISH.has(action) && action !== "kick") {
      return { status: 400, body: { ok: false, error: "Unknown staff command." } };
    }
    if (actorRole === "player") {
      return { status: 403, body: { ok: false, error: "A Player cannot run staff commands." } };
    }
    const allowed = COMMANDS[actorRole];
    if (allowed && !allowed.has(action)) {
      return { status: 403, body: { ok: false, error: "Your rank cannot use that command." } };
    }
    if (targetRole === "developer" || targetRole === "host") {
      return { status: 403, body: { ok: false, error: "A Developer or the world Host cannot be targeted by a staff command." } };
    }
    if (RANK[targetRole] >= RANK[actorRole]) {
      return { status: 403, body: { ok: false, error: "You cannot target a player of equal or higher rank." } };
    }
    if (actorUserId && target.userId && String(target.userId) === actorUserId) {
      return { status: 403, body: { ok: false, error: "You cannot target yourself." } };
    }
    if (!name) return { status: 400, body: { ok: false, error: "A target character is required." } };

    const live = onlineByName(this.api, name);
    const persistence = this.getPersistence();
    if (!live) {
      if (action === "kick") {
        return { status: 409, body: { ok: false, error: `${name} is offline.` } };
      }
      let exists = false;
      try {
        exists = Boolean(persistence?.exists?.(name, GameConstants.WORLD_PROFILE));
      } catch {
        exists = false;
      }
      if (!exists) return { status: 404, body: { ok: false, error: `${name} does not exist on this world.` } };
    }

    if (action === "kick") {
      live.requestLogout();
      return { status: 200, body: { ok: true, action, target: name, online: true } };
    }
    const punishment = this.getPunishment();
    if (!punishment || typeof punishment[action] !== "function") {
      return { status: 503, body: { ok: false, error: "Player punishment storage is unavailable." } };
    }
    const already = action === "ban" || action === "mute"
      ? punishment[action === "ban" ? "banned" : "muted"](key(name))
      : false;
    if (action === "ban" || action === "mute") {
      if (already) return { status: 409, body: { ok: false, error: `${name} is already ${action === "ban" ? "banned" : "muted"}.` } };
    }
    punishment[action](key(name));
    await punishment.flush?.();
    if (live) {
      if (action === "ban") live.requestLogout();
      else if (action === "mute") live.sendMessage("You have been muted by PaeScape staff.");
      else if (action === "unmute") live.sendMessage("You have been unmuted.");
    }
    return { status: 200, body: { ok: true, action, target: name, online: Boolean(live) } };
  }

  syncRank(body) {
    const userId = String(body?.userId ?? "");
    const role = roleOf(body?.role);
    if (!userId) return { status: 400, body: { ok: false, error: "A platform user id is required." } };
    const names = Array.isArray(body?.characterNames) ? body.characterNames : [];
    const updated = [];
    for (const raw of names) {
      const name = normaliseName(raw);
      if (!name) continue;
      this.pending.set(key(name), { userId, role });
      this.bindUserAccount(userId, name);
      const live = onlineByName(this.api, name);
      if (live) {
        applyRole(live, role, userId);
        updated.push(name);
      }
    }
    return { status: 200, body: { ok: true, role, updated } };
  }
}

module.exports = { StaffController, RANK, COMMANDS, roleOf };
