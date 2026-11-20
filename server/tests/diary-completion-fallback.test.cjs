// Run after `yarn build`: node --test tests/diary-completion-fallback.test.cjs
// When the AchievementDiaries plugin switch is off, AchievementDiaryCompletion stands in:
// every task is complete on login, diary queries answer as finished, and reward NPCs stay
// available with every unique reward item and perk still claimable. The auto-completed tiers
// do not hand out their antique lamps.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();

const Completion = require("../plugins/achievements/AchievementDiaryCompletion.plugin");
const Data = require("../plugins/achievements/diaries/Data.AchievementDiaries");
const Progress = require("../plugins/achievements/diaries/Progress.AchievementDiaries");
const Rewards = require("../plugins/achievements/diaries/Rewards.AchievementDiaries");

function createApi() {
  const handlers = new Map();
  const events = [];
  const api = new Proxy({
    core: {},
    persistAttribute() {},
    log() {},
    onCustomEvent(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    onPlayerLogin(handler) {
      const list = handlers.get("login") ?? [];
      list.push(handler);
      handlers.set("login", list);
    },
    emitCustomEvent(name, payload) {
      events.push({ name, payload });
      for (const handler of handlers.get(name) ?? []) handler(payload);
    },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  return { api, handlers, events };
}

function createPlayer() {
  const attributes = new Map();
  const varbits = [];
  return {
    attributes,
    varbits,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getPacketSender: () => ({ sendVarbit: (id, value) => varbits.push({ id, value }) }),
    isRegistered: () => true,
  };
}

function loadPlugin({ diaryPluginLoaded }) {
  const runtime = createApi();
  Completion.register(runtime.api);
  const loaded = runtime.handlers.get("plugins:loaded")[0];
  loaded({ names: new Set(diaryPluginLoaded ? ["AchievementDiaries"] : []) });
  return runtime;
}

function login(runtime, player) {
  for (const handler of runtime.handlers.get("login") ?? []) handler({ player });
}

test("with the real diary plugin loaded it only completes tasks on request and never answers queries", () => {
  const runtime = loadPlugin({ diaryPluginLoaded: true });
  const player = createPlayer();

  const before = { player, diary: "ardougne", tier: "easy", complete: false };
  runtime.api.emitCustomEvent("diary:is-complete", before);
  assert.equal(before.complete, false, "the real plugin owns the answers");

  const unrestricted = { player, unrestricted: false };
  runtime.api.emitCustomEvent("diary:rewards-unrestricted", unrestricted);
  assert.equal(unrestricted.unrestricted, false, "no bypass unless the diary is auto-completed");

  runtime.api.emitCustomEvent("diary:complete-all", { player, source: "level-up" });
  const ardougne = Data.BY_KEY.get("ardougne");
  const expected = Data.TIERS.flatMap((tier) => ardougne.tiers[tier].tasks.map(({ key }) => key));
  assert.deepEqual(new Set(player.getAttribute(Progress.TASKS_ATTRIBUTE).ardougne), new Set(expected));
  assert.ok(player.varbits.length > 0, "the diary tab receives its varbits");
});

test("with diaries off every task is done on login, unique rewards stay claimable and all queries answer", () => {
  const runtime = loadPlugin({ diaryPluginLoaded: false });
  const player = createPlayer();
  login(runtime, player);

  const tasks = player.getAttribute(Progress.TASKS_ATTRIBUTE);
  for (const diary of Data.DIARIES) {
    const expected = Data.TIERS.flatMap((tier) => diary.tiers[tier].tasks.map(({ key }) => key));
    assert.deepEqual(new Set(tasks[diary.key]), new Set(expected), `${diary.name} is complete`);

    assert.equal(Progress.isStarted(player, diary), true);
    assert.equal(Progress.doneTasks(player, diary).has(diary.tiers.easy.tasks[0].key), true);

    for (const tier of Data.TIERS) {
      const complete = { player, diary: diary.key, tier, complete: false };
      runtime.api.emitCustomEvent("diary:is-complete", complete);
      assert.equal(complete.complete, true, `${diary.name} ${tier}`);

      const claimed = { player, diary: diary.key, tier, claimed: true };
      runtime.api.emitCustomEvent("diary:is-reward-claimed", claimed);
      assert.equal(claimed.claimed, false, `${diary.name} ${tier} is still claimable from its NPC`);
    }
  }

  for (const diary of Data.DIARIES) {
    assert.equal(Rewards.claimableTier(player, diary), "easy",
      `${diary.name}'s first reward is handed out by its NPC`);
  }

  const all = { player, complete: false };
  runtime.api.emitCustomEvent("diary:all-complete", all);
  assert.equal(all.complete, true, "Twiggy's cape and the quest cape see every diary done");

  const tokkul = { player, amount: 100 };
  runtime.api.emitCustomEvent("diary:tokkul", tokkul);
  assert.equal(tokkul.amount, 200, "the elite Karamja reward doubles Tokkul");

  const unrestricted = { player, unrestricted: false };
  runtime.api.emitCustomEvent("diary:rewards-unrestricted", unrestricted);
  assert.equal(unrestricted.unrestricted, true, "stat-gated reward tiers can still be claimed");
  assert.equal(unrestricted.includeXpLamps, false, "the automatic completion withholds its XP lamp");

  const missing = { player, diary: "ardougne", task: "not-a-task", done: true };
  runtime.api.emitCustomEvent("diary:has-task", missing);
  assert.equal(missing.done, false, "unknown task keys are not answered as done");
});

test("automatic completion claims the diary item but filters out its lamp", () => {
  const runtime = loadPlugin({ diaryPluginLoaded: false });
  const player = createPlayer();
  login(runtime, player);

  const diary = Data.BY_KEY.get("ardougne");
  const policy = { player, unrestricted: false, includeXpLamps: true };
  runtime.api.emitCustomEvent("diary:rewards-unrestricted", policy);

  assert.deepEqual(Rewards.claimItems(diary, "easy", policy), [diary.tiers.easy.rewardItems[0]],
    "the unique diary item is still claimable");
  assert.deepEqual(Rewards.claimItems(diary, "easy"), diary.tiers.easy.rewardItems,
    "an ordinary earned completion still receives the lamp");
});

test("automatic completion removes the lamp promise from the claim transcript", () => {
  const karamja = Data.BY_KEY.get("karamja");
  const earned = Rewards.claimSteps(karamja.tiers.medium.claim, true);
  assert.ok(earned.some((step) => /lamp/i.test(String(step.npc ?? ""))),
    "an ordinary earned completion still hears about the lamp");

  const automatic = Rewards.claimSteps(karamja.tiers.medium.claim, false);
  assert.ok(!automatic.some((step) => /lamp/i.test(String(step.npc ?? step.player ?? ""))),
    "the automatic completion does not promise a lamp");
  assert.ok(automatic.some((step) => /Agility Arena\./.test(String(step.npc ?? ""))),
    "the tier's non-lamp description remains");

  const hard = Rewards.claimSteps(karamja.tiers.hard.claim, false);
  assert.ok(!hard.some((step) => /^too\.?$/i.test(String(step.npc ?? "").trim())),
    "the split 'too.' continuation of the lamp sentence is removed");
  assert.ok(hard.some((step) => /merchants will give ye discounts\./.test(String(step.npc ?? ""))),
    "the rest of the hard tier's description remains");
});
