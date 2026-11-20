"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const plugin = require("../plugins/npcs/AncientFungi.plugin");
const { pickFungus, ANCIENT_ZYGOMITE } = plugin._test;

function fungus(transformationId = 471) {
  let id = transformationId;
  let hitpoints = 0;
  let movementResets = 0;
  let wanderRadius = null;
  return {
    getNpcTransformationId: () => id,
    setNpcTransformationId: (value) => { id = value; },
    getMaxHitpoints: () => 72,
    setHitpoints: (value) => { hitpoints = value; },
    getMovementQueue: () => ({ reset: () => { movementResets++; } }),
    getMovementCoordinator: () => ({ setRadius: (value) => { wanderRadius = value; } }),
    transformationId: () => id,
    hitpoints: () => hitpoints,
    movementResets: () => movementResets,
    wanderRadius: () => wanderRadius,
  };
}

test("Pick turns an Ancient Fungi spawn into a rooted Ancient Zygomite", () => {
  const messages = [];
  const npc = fungus();
  assert.equal(pickFungus({ player: { sendMessage: (message) => messages.push(message) }, npc }), true);
  assert.equal(npc.transformationId(), ANCIENT_ZYGOMITE);
  assert.equal(npc.hitpoints(), 72);
  assert.equal(npc.movementResets(), 1);
  assert.equal(npc.wanderRadius(), 0);
  assert.match(messages[0], /pick the ancient fungi/i);
});

test("an Ancient Zygomite cannot be picked again", () => {
  const messages = [];
  const npc = fungus(ANCIENT_ZYGOMITE);
  assert.equal(pickFungus({ player: { sendMessage: (message) => messages.push(message) }, npc }), false);
  assert.deepEqual(messages, []);
});

test("every Ancient Fungi spawn is pinned with no wander radius", () => {
  const spawns = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../data/definitions/npc-spawns-custom.json"), "utf8"));
  const fungi = spawns.filter((spawn) => spawn.id === 471);
  assert.ok(fungi.length >= 27, `expected the Fossil Island fungi spawns, found ${fungi.length}`);
  assert.ok(fungi.every((spawn) => spawn.wanderRadius === 0), "all fungi stay on their spawn tile");
});

test("the plugin binds Pick to the Ancient Fungi NPC name", () => {
  let name;
  let actions;
  plugin.register({ onNpcInteraction: (npcName, handlers) => { name = npcName; actions = handlers; } });
  assert.equal(name, "Ancient Fungi");
  assert.equal(actions.Pick, pickFungus);
});
