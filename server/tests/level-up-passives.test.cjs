// Run after `yarn build`: node --test tests/level-up-passives.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const LeagueCommon = require("../plugins/modes/league/Common.LeagueMode");
const RelicsCommon = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
const Passives = require("../plugins/modes/league/Passives.LeagueMode");
const BoostedDrops = require("../plugins/modes/league/BoostedDrops.LeagueMode");

test("a Level-Up relic tier grants its passives, starting with no run-energy drain", () => {
  const attributes = new Map([["league:relics", { 0: 3 }]]);
  const player = {
    getProfile: () => "main",
    getAttribute: (key) => attributes.get(key),
  };
  const handlers = {};
  let drainModifier;
  const api = {
    core: { Skill: {} },
    getPluginConfig: (_key, fallback) => fallback,
    setWorldProfile() {},
    onCustomEvent: (name, handler) => { (handlers[name] ??= []).push(handler); },
    emitCustomEvent: (name, payload) => {
      if (name === "league:profile") payload.league = null;
      if (name === "level-up:relic-profile") {
        payload.league = 4;
        payload.active = true;
      }
      if (name === "league:highest-tier") payload.tier = 0;
      for (const handler of handlers[name] ?? []) handler(payload);
    },
    registerRunEnergyDrainModifier: (modifier) => { drainModifier = modifier; },
    onCanGainExperience() {},
  };
  LeagueCommon.init(api);
  RelicsCommon.init(api);
  Passives(api);

  assert.ok(Passives.passive(player, "runEnergy"), "tier 1's run-energy passive is active");
  assert.equal(drainModifier(player, 200), 0, "a running step drains no energy");
  assert.equal(BoostedDrops.rule(player, "Abyssal demon")?.multiplier, 2, "tier 1 also boosts eligible drops");
  assert.equal(BoostedDrops.rule(player, "Scurrius")?.pattern.test("Scurrius' spine"), true, "Level-Up's Scurrius spine is eligible too");
});
