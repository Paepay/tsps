"use strict";

/**
 * The generals' chambers: the doors, the private instances and the altars.
 *
 * - Open: into the shared chamber for 40 of the god's essence, or an ecumenical key when the
 *   essence is short ("Your ecumenical key melts into the door.", captured). From inside, the
 *   door lets the player out. An account the world keeps isolated (Ironman, a league character,
 *   or wealth transfer off) gets its own chamber from this option instead: it never shares a
 *   boss, and the 150,000-coin instance fee does not apply (issue #68).
 * - The instance option: a private copy of the chamber for 150,000 coins on top of the essence.
 *   A chamber stays built for a while after its owner leaves (the door, a teleport, a crystal
 *   of memories), so coming back finds the same NPCs instead of a fresh copy (issue #68).
 *   tsps has no Combat Achievements, so the Hard tier's price applies to everyone. As captured,
 *   godwars_fader_init fades the overlay, the chamber is rebuilt a tick later around the same
 *   inside tile, and varbit godwars_instance is 1 while in it.
 * - Peek: how many adventurers are in the shared chamber.
 * - Altars: Pray restores Prayer, plus one point per item of the god worn, once every 10 minutes
 *   and not in combat; Teleport leaves the chamber, in combat too (Wiki). The lines, the shared
 *   cooldown and the teleport's ticks are recorded (Common.prayAtAltar / altarTeleport).
 */
const fs = require("fs");
const path = require("path");
const Combat = require("./Combat.GodWars");
const Common = require("./Common.GodWars");
const Dungeon = require("./Dungeon.GodWars");
const Rules = require("./Rules.GodWars");

const CHUNK = 8;
const PLANES = 4;
const COINS = 995;
/** Ticks a built chamber waits for its owner to come back before it is destroyed. */
const INSTANCE_PARK_TICKS = 1000;

/** Faction key -> the chamber's general and bodyguard spawns, from npc-spawns.json. */
let chamberSpawns = null;

function loadChamberSpawns() {
  const file = path.join(__dirname, "..", "..", "..", "data", "definitions", "npc-spawns.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  chamberSpawns = new Map();
  for (const faction of Common.factions) {
    const ids = new Set([faction.general, ...faction.bodyguards]);
    chamberSpawns.set(faction.key, rows.filter((row) =>
      ids.has(row.id) && Common.inBox(faction.room, row.x, row.y, row.level ?? 0)));
  }
}

/** Player -> their private chamber while they are in it. */
const instances = new Map();

/** Numbers each private chamber, so its NPCs' unique keys are its own. */
let chamberSerial = 0;

let InstanceClass = null;

function instanceClass() {
  if (InstanceClass) return InstanceClass;
  const { TemplatedInstanceArea } = Common.core;
  InstanceClass = class GodWarsChamber extends TemplatedInstanceArea {
    constructor(faction, player) {
      super(faction.instance.width, faction.instance.height);
      this.faction = faction;
      this.player = player;
      this.isGodWarsInstance = true;
      this.serial = ++chamberSerial;
      const { chunkX, chunkY, width, height } = faction.instance;
      for (let plane = 0; plane < PLANES; plane++) {
        for (let x = 0; x < width; x++) {
          for (let y = 0; y < height; y++) {
            this.setChunk(plane, x, y, { sourceChunkX: chunkX + x, sourceChunkY: chunkY + y, sourcePlane: plane, rotation: 0 });
          }
        }
      }
    }

    getName() {
      return `God Wars Dungeon (${this.faction.name}, private)`;
    }

    isMulti() {
      return true;
    }

    allowSummonPet() {
      return false;
    }

    canAttack(attacker, target, method) {
      return Combat.deniesMelee(attacker, target, method);
    }

    /** The instance's copy of a real tile. */
    copyOf([x, y, z]) {
      const { chunkX, chunkY } = this.faction.instance;
      return this.tile(x - chunkX * CHUNK, y - chunkY * CHUNK, z ?? 0);
    }

    /** The real chamber tile an instance tile was copied from. */
    sourceOf(location) {
      const { chunkX, chunkY } = this.faction.instance;
      // The chunk grid sits at this instance allocation, not at the source chunk: undo the base
      // before adding the copied chunk back.
      return Common.toLocation([
        location.getX() - this.getBaseX() + chunkX * CHUNK,
        location.getY() - this.getBaseY() + chunkY * CHUNK,
        location.getZ(),
      ]);
    }

    spawnChamber() {
      (chamberSpawns.get(this.faction.key) ?? []).forEach((row, slot) => this.spawn(row, slot));
    }

    /** One NPC per spawn row: a respawn never lands while the row's NPC is still alive. */
    spawn(row, slot) {
      if (this.isDestroyed()) return;
      const at = this.copyOf([row.x, row.y, row.level ?? 0]);
      const unique = `godwars:chamber:${this.serial}:${slot}`;
      const npc = Common.api.spawnNpc({ id: row.id, x: at.getX(), y: at.getY(), z: at.getZ(), wanderRadius: 4, unique });
      if (!npc) return;
      npc.__skipDefaultRespawn = true;
      npc.__godwarsChamber = { area: this, row, slot };
      this.add(npc);
    }

    process(mobile) {
      if (!mobile.isPlayer() || mobile.getHitpoints() <= 0) return;
      Combat.engage(mobile.getAsPlayer(), this.faction, this.entities.filter((entity) => entity.isNpc?.()));
    }

    postEnter(mobile) {
      super.postEnter(mobile);
      if (!mobile.isPlayer()) return;
      const player = mobile.getAsPlayer();
      player.setAttribute(Common.CHAMBER_ATTRIBUTE, this.faction.key);
      Dungeon.openOverlay(player);
      player.getPacketSender().sendVarbit(Common.data.instanceVarbit, 1);
    }

    /**
     * Leaving returns the player outside; logging out puts them outside its door first. A chamber
     * left behind stays built for INSTANCE_PARK_TICKS so its NPCs keep their state.
     */
    postLeave(mobile, logout) {
      if (!mobile.isPlayer() || mobile.getAsPlayer() !== this.player) {
        super.postLeave(mobile, logout);
        return;
      }
      const player = this.player;
      // PrivateArea.postLeave destroys an empty chamber. Keep this one alive so a teleport back
      // and the door can re-enter the same NPCs; `end` destroys it when the park expires.
      this.remove(mobile);
      player.setAttribute(Common.CHAMBER_ATTRIBUTE, null);
      player.getPacketSender().sendVarbit(Common.data.instanceVarbit, 0);
      if (logout) {
        player.setLocation(Common.toLocation(this.faction.door.outside));
        end(player);
        return;
      }
      Common.later(1, () => player.isRegistered() && !Dungeon.inGodWars(player) && Dungeon.closeOverlay(player));
      park(player, this);
    }

    destroy() {
      if (this.isDestroyed()) return;
      for (const entity of [...this.entities]) {
        if (!entity.isNpc?.()) continue;
        this.detach(entity);
        Common.api.removeNpc(entity);
      }
      super.destroy();
    }
  };
  return InstanceClass;
}

/**
 * Keeps a chamber built after its owner leaves. A returning player (the door, or a crystal of
 * memories' teleport back) finds the same NPCs: a boss killed before leaving stays dead for
 * its own respawn timer instead of a new copy spawning. It is destroyed after the wait unless
 * its owner is back inside.
 */
function park(player, area) {
  const token = (area.parkToken ?? 0) + 1;
  area.parkToken = token;
  Common.later(INSTANCE_PARK_TICKS, () => {
    if (instances.get(player) !== area || area.parkToken !== token || area.hasMember(player)) return;
    end(player);
  });
}

function end(player) {
  const area = instances.get(player);
  if (!area) return;
  instances.delete(player);
  if (!area.isDestroyed()) area.destroy();
}

const instanceOf = (player) => instances.get(player) ?? null;

/** The chamber the player stands in: [faction, their instance or null], or null outside. */
function chamberOf(player) {
  const area = instanceOf(player);
  if (area && area.hasMember(player)) return [area.faction, area];
  const faction = Common.factionForRoom(player.getLocation());
  return faction ? [faction, null] : null;
}

function isIronman(player) {
  const query = { player, mode: "none" };
  Common.api.emitCustomEvent("ironman:mode", query);
  return query.mode !== "none";
}

/** Whether the player is a league character (LeagueMode answers `league:profile`). */
function isLeagueCharacter(player) {
  const query = { player, league: null };
  Common.api.emitCustomEvent("league:profile", query);
  return query.league !== null && query.league !== undefined;
}

/**
 * Whether the world keeps this account out of shared chambers: an Ironman, a league character
 * (including Level-Up's relic profile), or any account on a world without wealth transfer.
 */
function isolatedAccount(player) {
  if (isIronman(player) || isLeagueCharacter(player)) return true;
  const levelUp = { player, league: null, active: false };
  Common.api.emitCustomEvent("level-up:relic-profile", levelUp);
  if (levelUp.active === true) return true;
  if (Common.api.getPluginConfig?.("WealthTransfer:enabled", true) === false) return true;
  const wealth = { enabled: true };
  Common.api.emitCustomEvent("wealth:enabled", wealth);
  return wealth.enabled === false;
}

/** Spends the door's price: 40 essence, else the key. False (with the captured message) if short. */
function payEntry(player, faction) {
  const result = Rules.canOpenBossDoor({
    killCount: Common.getEssence(player, faction),
    hasKey: player.getInventory().contains(Common.core.ItemIdentifiers.ECUMENICAL_KEY),
    required: Common.data.essence.required,
  });
  if (!result.ok) {
    player.sendMessage(`This door is locked by the power of ${faction.name}! You will need to collect the essence of at least ${result.required} of his followers before the door will open.`);
    return false;
  }
  if (result.consumesKey) {
    player.getInventory().delete(Common.core.ItemIdentifiers.ECUMENICAL_KEY, 1);
    // rsprox: spam (224/01461.txt:3604).
    player.getPacketSender().sendTypedMessage(Common.core.ChatType.SPAM, "Your ecumenical key melts into the door.");
  } else {
    Common.setEssence(player, faction, Common.getEssence(player, faction) - result.spendsEssence);
    player.sendMessage(`The door devours the life-force of ${result.spendsEssence} followers of ${faction.name} that you have slain.`);
  }
  return true;
}

/** Out through the door: the instance ends, or the shared door swings open behind the player. */
function leaveChamber(player, faction, area) {
  player.getMovementQueue().reset();
  if (area) {
    player.moveTo(Common.toLocation(faction.door.outside));
    return;
  }
  Common.swingDoor(faction);
  Common.later(1, () => player.isRegistered() && player.moveTo(Common.toLocation(faction.door.outside)));
}

function openDoor({ player, objectId }) {
  const faction = Common.factionForDoor(objectId);
  if (!faction) return false;
  const inside = chamberOf(player);
  if (inside) {
    leaveChamber(player, inside[0], inside[1]);
    return true;
  }
  // Isolated accounts never share a chamber (issue #68); their own room costs the essence only.
  if (isolatedAccount(player)) return startPrivate(player, faction, false);
  if (!payEntry(player, faction)) return true;
  player.getMovementQueue().reset();
  Common.swingDoor(faction);
  Common.later(1, () => player.isRegistered() && player.moveTo(Common.toLocation(faction.door.inside)));
  return true;
}

/** Into a chamber already built for this player, without another instance fee. */
function reenter(player, area) {
  const faction = area.faction;
  player.getMovementQueue().reset();
  Common.swingDoor(faction);
  Common.later(1, () => {
    if (!player.isRegistered()) return;
    area.enter(player);
    player.moveTo(area.copyOf(faction.door.inside));
  });
}

/**
 * A crystal of memories' teleport back into a parked private chamber: the saved location is a real
 * chamber tile, mapped back into this player's own copy. A chamber that has been ended or belongs
 * to another god is not revived; the caller's public landing is then left in place.
 */
function recallPrivate(event) {
  const { player, faction, location } = event;
  const area = instanceOf(player);
  if (!area || area.isDestroyed() || area.faction.key !== faction || !location
      || !Common.inBox(area.faction.room, location.getX(), location.getY(), location.getZ())) return false;
  player.getMovementQueue().reset();
  area.enter(player);
  player.moveTo(area.copyOf([location.getX(), location.getY(), location.getZ()]));
  event.handled = true;
  return true;
}

/**
 * The private chamber, as captured: the fade, then a tick later the rebuilt chamber. A chamber
 * this player already has is re-entered (the essence is paid again, the coins are not).
 */
function startPrivate(player, faction, chargeCoins) {
  const existing = instanceOf(player);
  if (existing && existing.faction === faction && !existing.hasMember(player)) {
    if (!payEntry(player, faction)) return true;
    reenter(player, existing);
    return true;
  }
  const cost = Common.data.instanceCost;
  if (chargeCoins && player.getInventory().getAmount(COINS) < cost) {
    player.sendMessage(`You need ${cost.toLocaleString("en-US")} coins to start your own instance.`);
    return true;
  }
  if (!payEntry(player, faction)) return true;
  if (chargeCoins) player.getInventory().delete(COINS, cost);
  player.getMovementQueue().reset();
  const { overlay } = Common.data;
  player.getPacketSender().sendClientScript(overlay.faderScript, 1, 0, 1, (overlay.group << 16) | overlay.fader);
  Common.later(1, () => {
    if (!player.isRegistered()) return;
    end(player);
    const area = new (instanceClass())(faction, player);
    instances.set(player, area);
    area.spawnChamber();
    area.enter(player);
    player.moveTo(area.copyOf(faction.door.inside));
  });
  return true;
}

function startInstance({ player, objectId }) {
  const faction = Common.factionForDoor(objectId);
  if (!faction) return false;
  const inside = chamberOf(player);
  if (inside) {
    leaveChamber(player, inside[0], inside[1]);
    return true;
  }
  return startPrivate(player, faction, !isolatedAccount(player));
}

function peek({ player, objectId }) {
  const faction = Common.factionForDoor(objectId);
  if (!faction) return false;
  const count = Dungeon.chamberOccupants(faction);
  player.sendMessage(count === 0
    ? "You peek inside the door and see no adventurers in the room."
    : `You peek inside the door and see ${count} adventurer${count === 1 ? "" : "s"} in the room.`);
  return true;
}

/** Pray: Prayer restored, plus one point per item of the god worn (Common.prayAtAltar has the recorded lines). */
function pray({ player, objectId }) {
  const faction = Common.factionForAltar(objectId);
  if (!faction) return false;
  const max = player.getSkillManager().getMaxLevel(Common.core.Skill.PRAYER);
  Common.prayAtAltar(player, max + Common.godItemCount(player, faction));
  return true;
}

/**
 * Teleport: out past the chamber's door, a private chamber left parked behind them, on the recorded ticks. The landing is
 * one tile beyond the door's outer tile: Bandos (2861, 5354, 2) in local 1000402 t26539 and Saradomin
 * (2910, 5265, 0) in local 1000361 t11609. Ours: Armadyl and Zamorak are unrecorded and use the same step out.
 */
function teleportOut({ player, objectId }) {
  const faction = Common.factionForAltar(objectId);
  if (!faction) return false;
  const landing = Common.toLocation(faction.door.landing);
  Common.altarTeleport(player, landing, () => player.moveTo(landing));
  return true;
}

/** Saved inside a private chamber (the server stopped): back outside its door. */
function recoverOnLogin({ player }) {
  const faction = Common.factionByKey(player.getAttribute(Common.CHAMBER_ATTRIBUTE));
  if (!faction || instanceOf(player)) return;
  player.setAttribute(Common.CHAMBER_ATTRIBUTE, null);
  player.moveTo(Common.toLocation(faction.door.outside));
}

/** A chamber's NPC comes back in its instance 150 ticks after dying, while the instance lasts. */
function respawnInChamber(event) {
  const chamber = event.npc?.__godwarsChamber;
  if (!chamber) return;
  event.npc.__skipDefaultRespawn = true;
  Common.later(Common.data.respawnTicks, () => chamber.area.spawn(chamber.row, chamber.slot));
}

function attachChambers(api) {
  loadChamberSpawns();
  api.persistAttribute(Common.ALTAR_ATTRIBUTE);
  api.persistAttribute(Common.CHAMBER_ATTRIBUTE);
  api.onPlayerLogin(recoverOnLogin);
  const doors = Common.factions.map((faction) => faction.door.id);
  const altars = Common.factions.map((faction) => faction.altar);
  api.onObjectFirstClick(doors, openDoor);
  api.onObjectSecondClick(doors, startInstance);
  api.onObjectThirdClick(doors, peek);
  api.onObjectFirstClick(altars, pray);
  api.onObjectSecondClick(altars, teleportOut);
  api.onCustomEvent("godwars:chamber-recall", recallPrivate);
  api.onNpcDeath(respawnInChamber);
}

module.exports = { attachChambers, instanceOf, _test: { end, park, recallPrivate, isolatedAccount, isLeagueCharacter, startPrivate } };
