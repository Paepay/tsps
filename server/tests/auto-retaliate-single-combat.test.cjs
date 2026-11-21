// Run after `yarn build`: node --test tests/auto-retaliate-single-combat.test.cjs
//
// PaeScape_Issues#82: with auto-retaliate on, clicking a second NPC while a monster is
// already attacking the player replaces the interaction with that NPC. Single combat refuses
// the click with "I'm already under attack." and keeps the clicked NPC waiting. The next hit
// from the original monster must still make the player retaliate: the waiting click is not an
// attack in progress, so it must not suppress auto-retaliation.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { Combat } = require("../dist/game/content/combat/Combat");
const { CombatFactory, CanAttackResponse } = require("../dist/game/content/combat/CombatFactory");
const { Location } = require("../dist/game/model/Location");
const { TaskManager } = require("../dist/game/task/TaskManager");

/** A mobile in Lumbridge (single combat) with a real Combat and the bits attack() touches. */
function mobile(kind, name) {
  const messages = [];
  const queue = {
    reset() {},
    endClickRunOverride() {},
    size: () => 0,
    isMovings: () => false,
  };
  const self = {
    messages,
    isPlayer: () => kind === "player",
    isNpc: () => kind === "npc",
    getAsPlayer: () => self,
    getAsNpc: () => self,
    isMultiCombat: () => false,
    getOwner: () => null,
    getUsername: () => name,
    getDisplayName: () => name,
    getDueling: () => null,
    getArea: () => null,
    getPrivateArea: () => null,
    getLocation: () => new Location(3222, 3218, 0),
    getHitpoints: () => 10,
    getIndex: () => 0,
    isRegistered: () => true,
    isUntargetable: () => false,
    isNeedsPlacement: () => false,
    isTeleportingReturn: () => false,
    isDyingReturn: () => false,
    isDyingFunction: () => false,
    autoRetaliateReturn: () => true,
    getCurrentDefinition: () => ({ isAttackable: () => true }),
    getMovementCoordinator: () => ({ getCoordinateState: () => 0 }),
    interactionCleared() {},
    setFollowing() {},
    sendMessage: (message) => messages.push(message),
    getMovementQueue: () => queue,
    setMobileInteraction() {},
    setPositionToFace() {},
    performAnimation() {},
    getPacketSender: () => ({ sendConfig() {}, sendTypedMessage: (type, m) => messages.push(m) }),
  };
  self.combat = new Combat(self);
  self.getCombat = () => self.combat;
  return self;
}

test("a clicked second NPC does not stop auto-retaliation against the monster already attacking", () => {
  const player = mobile("player", "You");
  const attacker = mobile("npc", "Goblin");
  const clicked = mobile("npc", "Rat");
  const combat = player.getCombat();

  // The goblin hits the player. Auto-retaliate is on, so the player answers it.
  combat.setUnderAttack(attacker);
  combat.attack(attacker, true);
  assert.equal(combat.getTarget(), attacker);
  assert.equal(combat.isAutoRetaliating(), true);

  // Clicking a second NPC is refused in single combat, and that click becomes the target
  // that waits until the player is free.
  combat.attack(clicked);
  assert.equal(combat.getTarget(), clicked);
  assert.equal(combat.isAutoRetaliating(), false);
  assert.equal(CombatFactory.canAttackPermission(player, clicked, true), CanAttackResponse.ALREADY_UNDER_ATTACK);

  // The goblin hits again. The waiting click is not an active attack, so the player must
  // answer the goblin instead of standing idle.
  CombatFactory.handleRetaliation(attacker, player);
  TaskManager.process();
  assert.equal(combat.getTarget(), attacker, "auto-retaliation answers the monster that hit the player");
  assert.equal(combat.isAutoRetaliating(), true);
});
