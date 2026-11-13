"use strict";

/**
 * Level-Up's server-driven screens. It reuses the Demonic Pacts/Leagues interfaces
 * (journal 629, side panel 656, tasks 657, areas 512, relics 655, combat masteries
 * 311) without becoming a seasonal league character: regions and relics advance on
 * the skill milestones in issue #7, and the task list is the ten combat mastery
 * challenges rather than seasonal tasks.
 */

const Rules = require("./Rules.LevelUpWorld");
const TemplateWorlds = require("../TemplateWorlds.plugin");
const LeagueCommon = require("../league/Common.LeagueMode");

const JOURNAL = Object.freeze({
  group: 629,
  leagueTab: 34,
  leagueIcon: 42,
  container: 43,
  tabIndex: 4,
  panel: 656,
  pointsFill: 23,
  fillScript: 3226,
});
const LEAGUE_TYPE_VARBIT = 10032;
const LEAGUE_ACCOUNT_VARBIT = 10031;
const LEAGUE_TUTORIAL_VARBIT = 10037;
const TOTAL_TASKS_VARBIT = 10046;
const JOURNAL_TAB_VARBIT = 8168;
const RUNEDAY_VARBIT = 9535;
const MAP_FLAGS_VARP = 3717;
const LEAGUE_WORLD_FLAG = 1 << 30;

const TASK_TYPE = 7;

/** The cache's league mastery challenge enum (keys 1-10, structs 1177-1186). */
const CHALLENGE_ENUM = 5695;

const AREA_GROUP = 512;
const AREA_MENU_FRAME = 7;
const AREA_MENU_SLOTS = [10, 18];
const AREA_CONFIRM = 62;
const AREA_TELEPORT = 84;
const AREA_NAME_HEADER = 44;

const RELIC_GROUP = 655;
const RELIC_CLICKZONES = 22;
const RELIC_CLICKZONE_SLOTS = [0, 23];
const RELIC_MENU_FRAME = 6;
const RELIC_MENU_SLOTS = [10, 20];
const RELIC_CONFIRM = 51;
const RELIC_TOGGLES = 38;

const FLAGS_OP1 = 1 << 1;
const FLAG_SCRIPT_TRIGGER = -1;
const LEAGUE_STYLE_TYPE = 4;
const CLAIMED_POINTS_VARP = 2615;

/** The task list's runtime components (the cache builds 657's rows from its scripts). */
const TASK_SCREEN = Object.freeze({
  group: 657,
  title: 32810,
  banner: 32785,
  rowBase: 32820,
  rowStride: 5,
  rewardOffset: 4,
});

/** The area screen's script-written header texts. */
const AREA_TEXT = Object.freeze({
  title: 32770,
  banner: 32787,
  summary: 32790,
});

/** The relic screen's script-written header texts. */
const RELIC_TEXT = Object.freeze({
  points: 32960,
  banner: 33103,
});

let api = null;
let core = null;
let AreaCommon = null;
let RelicCommon = null;
let RelicCatalog = null;
let AreaData = null;
let RelicData = null;

const panelOpen = new WeakSet();
const areaViewing = new WeakMap();
const relicViewing = new WeakMap();

const uid = (group, child) => (group << 16) | child;

function active() {
  return TemplateWorlds._test.active();
}

function progress(player) {
  return TemplateWorlds.progress(player);
}

function runeday() {
  const Common = require("../league/Common.LeagueMode");
  if (Common.data) return Common.runeday();
  return Math.floor((Date.now() - Date.parse("2002-02-27T00:00:00Z")) / 86400000);
}

/** The client hides the journal's Leagues tab without the league-world map flag. */
function mapFlags(request) {
  if (!active() || !request?.player) return;
  request.flags = (request.flags | 0) | LEAGUE_WORLD_FLAG;
}

/** Make the Leagues tab available and select its panel, as a league login does. */
function sendJournalAvailability(player) {
  if (!active() || !player?.getPacketSender) return;
  const sender = player.getPacketSender();
  const flags = { player, flags: 0 };
  api.emitCustomEvent("world:map-flags", flags);
  sender.sendConfig(MAP_FLAGS_VARP, flags.flags | 0);
  sender.sendVarbit(LEAGUE_ACCOUNT_VARBIT, 1);
  sender.sendVarbit(LEAGUE_TYPE_VARBIT, LEAGUE_STYLE_TYPE);
  sender.sendVarbit(LEAGUE_TUTORIAL_VARBIT, 12);
  sender.sendVarbit(RUNEDAY_VARBIT, runeday());
}

function mastery() {
  const Common = require("../leaguemasteries/Common.LeagueCombatMasteries");
  if (!Common.data) Common.init(api);
  return Common;
}

function sendPanelText(player, child, text) {
  player.getPacketSender().sendString(text, uid(JOURNAL.panel, child), true);
}

function sendText(player, group, child, text) {
  player.getPacketSender().sendString(text, uid(group, child), true);
}

function nextRegionText(state) {
  if (state.pendingRegionMilestone !== null) {
    return "<col=ffffff>Choose a region</col> now!";
  }
  if (state.nextRegionMilestone === null) return "<col=ffffff>All regions claimed.</col>";
  return `Region next: <col=ffffff>${state.nextRegionMilestone}</col> skills`;
}

function nextRelicText(state) {
  if (state.pendingRelicMilestone !== null) {
    return "<col=ffffff>Choose a relic</col> now!";
  }
  if (state.nextRelicMilestone === null) return "<col=ffffff>All relics claimed.</col>";
  return `Relic next: <col=ffffff>${state.nextRelicMilestone}</col> skills`;
}

function refreshPanel(player) {
  if (!active() || !panelOpen.has(player)) return;
  const state = progress(player);
  const Common = mastery();
  const earned = Common.earned(player);
  const completed = Common.completedChallenges(player);
  const available = Common.available(player);
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(JOURNAL.fillScript, [uid(JOURNAL.panel, JOURNAL.pointsFill), available]);
  sender.sendVarbit(TOTAL_TASKS_VARBIT, earned);
  sendPanelText(player, 4, "Level-Up");
  sendPanelText(player, 18, nextRegionText(state));
  sendPanelText(player, 19, nextRelicText(state));
  sendPanelText(player, 25, "Mastery tasks:");
  sendPanelText(player, 26, `${completed}/${Common.levelUpChallenges().length}`);
  sendPanelText(player, 27, "Mastery points:");
  sendPanelText(player, 28, `${earned} earned`);
  sendPanelText(player, 33, "Masteries");
  sendPanelText(player, 37, "Tasks");
  sendPanelText(player, 41, "Areas");
  sendPanelText(player, 45, "Relics");
}

/** The task screen's runtime rows are the working combat mastery challenges, not seasonal tasks. */
function sendTaskOverrides(player) {
  if (!active()) return;
  const Common = mastery();
  const completed = Common.completedChallenges(player);
  const total = Common.levelUpChallenges().length;
  sendText(player, TASK_SCREEN.group, TASK_SCREEN.title,
    `Combat Mastery Tasks <col=ffffff>${completed}/${total}</col>`);
  sendText(player, TASK_SCREEN.group, TASK_SCREEN.banner,
    "Complete challenges for Combat Mastery points.");
  for (let index = 0; index < total; index++) {
    sendText(player, TASK_SCREEN.group, TASK_SCREEN.rowBase + index * TASK_SCREEN.rowStride + TASK_SCREEN.rewardOffset,
      "Reward: <col=ffffff>1 Combat Mastery point");
  }
}

/**
 * The mastery challenge enum, cut to the challenges this cache supports. The
 * league interface draws one row per enum entry, so Level-Up omits the Echo
 * challenges here instead of leaving three rows that can never complete. Other
 * modes keep the cache's full enum.
 */
function challengeEnumRow() {
  const Common = mastery();
  return {
    enumId: CHALLENGE_ENUM,
    valueType: "J",
    defaultValue: -1,
    entries: Common.levelUpChallenges().map((challenge, index) => [index + 1, challenge.struct]),
  };
}

/** LeagueMode content rows: Level-Up answers with the filtered challenge enum. */
function content(query) {
  if (!active() || !query || Number(query.league) !== TASK_TYPE) return;
  query.enums.push(challengeEnumRow());
}
function sendAreaOverrides(player) {
  const state = progress(player);
  const total = Rules.REGION_MILESTONES.length + 1;
  sendText(player, AREA_GROUP, AREA_TEXT.title, "Level-Up Areas");
  sendText(player, AREA_GROUP, AREA_TEXT.banner,
    `${state.unlockedCount}/${Rules.TOTAL_SKILLS} skills unlocked`);
  sendText(player, AREA_GROUP, AREA_TEXT.summary,
    `You have unlocked ${state.regions.length}/${total} areas.`);
}

function sendRelicOverrides(player) {
  const state = progress(player);
  const total = Rules.RELIC_MILESTONES.length;
  const banner = state.pendingRelicMilestone !== null
    ? "<col=ffffff>A relic choice is ready!</col>"
    : state.nextRelicMilestone === null
      ? "<col=ffffff>All relic choices claimed.</col>"
      : `Next relic at <col=ffffff>${state.nextRelicMilestone}</col> skills.`;
  sendText(player, RELIC_GROUP, RELIC_TEXT.points, `${state.relics.length}/${total} relics unlocked`);
  sendText(player, RELIC_GROUP, RELIC_TEXT.banner, banner);
}

function openJournal(event) {
  if (!active()) return false;
  const { player } = event;
  const Common = mastery();
  const sender = player.getPacketSender();
  sendJournalAvailability(player);
  sender.sendVarbit(JOURNAL_TAB_VARBIT, JOURNAL.tabIndex);
  sender.sendVarbit(TOTAL_TASKS_VARBIT, Common.earned(player));
  sender.sendSubInterface(uid(JOURNAL.group, JOURNAL.container), JOURNAL.panel);
  panelOpen.add(player);
  player.setAttribute("level-up:journal-open", true);
  refreshPanel(player);
  api.emitCustomEvent("journal:tab-mounted", { player, groupId: JOURNAL.panel, tabIndex: JOURNAL.tabIndex });
  event.handled = true;
  return true;
}

function journalTabMounted({ player, groupId }) {
  if (!player) return;
  if (Number(groupId) === JOURNAL.panel) {
    panelOpen.add(player);
    player.setAttribute("level-up:journal-open", true);
    return;
  }
  panelOpen.delete(player);
  player.setAttribute("level-up:journal-open", false);
}

function restoreJournal({ player }) {
  if (!player || !active()) return;
  sendJournalAvailability(player);
  if (player.getAttribute("level-up:journal-open") !== true) return;
  openJournal({ player });
}

function pointsChanged({ player }) {
  if (player) refreshPanel(player);
}

function skillChanged({ player }) {
  if (player) refreshPanel(player);
}

function statIndexByChild() {
  const result = new Map();
  for (const skill of Rules.SKILLS) result.set(Rules.statChild(skill.index), skill.index);
  return result;
}

const STAT_INDEX = statIndexByChild();

function locked(player, index) {
  return !progress(player).unlockedSkills.some((skill) => skill.index === Number(index));
}

function promptUnlock(player, index) {
  const skill = Rules.skill(index);
  if (!skill || !locked(player, index)) return false;
  const { DialogueChainBuilder, OptionDialogue } = core;
  player.getPacketSender().sendInterfaceRemoval();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new OptionDialogue(0, {
      executeOption(option) {
        player.getPacketSender().sendInterfaceRemoval();
        if (Number(option) === 1) TemplateWorlds.unlockSkill(player, skill.name);
      },
    }, "Yes", "No").setTitle(`Unlock ${skill.name}`),
  ));
  return true;
}

function statClicked(event) {
  if (!active()) return false;
  const index = STAT_INDEX.get(Number(event.childId ?? (event.buttonId & 0xffff)));
  if (index === undefined || !locked(event.player, index)) return false;
  return promptUnlock(event.player, index);
}

function statOffered(offer) {
  if (!active() || offer?.handled) return;
  const index = STAT_INDEX.get(Number(offer?.childId));
  if (index === undefined || !locked(offer.player, index)) return;
  offer.handled = promptUnlock(offer.player, index);
}

function areaCommon() {
  if (!AreaCommon.data) AreaCommon.init(api);
  return AreaCommon;
}

function sendAreaState(player) {
  const state = progress(player);
  const unlocked = state.regions
    .map((entry) => Rules.region(entry.id)?.area)
    .filter(Number.isInteger);
  const sender = player.getPacketSender();
  AreaData.varbits.selection.forEach((varbit, slot) => sender.sendVarbit(varbit, unlocked[slot] ?? 0));
  sender.sendVarbit(AreaData.varbits.available, state.pendingRegionMilestone !== null ? 1 : 0);
  sender.sendVarbit(AreaData.varbits.lastViewed, 0);
}

function openAreas(event) {
  if (!active()) return false;
  const { player } = event;
  api.emitCustomEvent("league:modal-opening", { player, group: AREA_GROUP });
  sendAreaState(player);
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(AreaData.interface.modalSize[0], AreaData.interface.modalSize[1]);
  sender.sendInterface(AREA_GROUP);
  sender.sendInterfaceFlagsRange(uid(AREA_GROUP, AREA_MENU_FRAME), AREA_MENU_SLOTS[0], AREA_MENU_SLOTS[1], FLAGS_OP1);
  sendAreaOverrides(player);
  areaViewing.set(player, -1);
  event.handled = true;
  return true;
}

function areaOfButton(buttonId) {
  for (const area of areaCommon().areas.values()) {
    if (area.shield === buttonId || area.nameComponent === buttonId) return area;
  }
  return null;
}

function areaState(player, areaId) {
  const state = progress(player);
  if (state.regions.some((entry) => Rules.region(entry.id)?.area === areaId)) return AreaData.interface.states.unlocked;
  if (state.pendingRegionMilestone !== null) return AreaData.interface.states.available;
  return AreaData.interface.states.message;
}

function showArea(player, area) {
  const state = areaState(player, area.id);
  const text = state === AreaData.interface.states.message
    ? `Reach ${progress(player).nextRegionMilestone} unlocked skills to earn another region choice.`
    : "";
  areaViewing.set(player, area.id);
  const { viewScript, viewScriptComponentsBefore, viewScriptComponentsAfter } = AreaData.interface;
  player.getPacketSender().sendVarbit(AreaData.varbits.lastViewed, area.id);
  player.getPacketSender().sendInterfaceScript(viewScript, [
    area.id,
    ...viewScriptComponentsBefore.map((child) => uid(AREA_GROUP, child)),
    state,
    ...viewScriptComponentsAfter.map((child) => uid(AREA_GROUP, child)),
    text,
  ]);
  return true;
}

function areaShieldClicked(event) {
  if (!active() || !areaViewing.has(event.player)) return false;
  const area = areaOfButton(Number(event.buttonId));
  return area ? showArea(event.player, area) : false;
}

function areaHeaderClicked(event) {
  if (!active() || !areaViewing.has(event.player)) return false;
  const area = areaCommon().area(areaViewing.get(event.player));
  return area ? showArea(event.player, area) : false;
}

function presentArea(player, area) {
  const { Animation, Graphic } = core;
  const graphic = areaCommon().spotanim(LEAGUE_STYLE_TYPE, area.id);
  player.performAnimation(new Animation(AreaData.interface.unlockAnimation));
  if (graphic >= 0) player.performGraphic(new Graphic(graphic, 0, 0));
  player.getPacketSender().sendInterfaceRemoval();
  for (const [sound, delay] of AreaData.interface.unlockSounds) player.getPacketSender().sendSound(sound, 1, delay);
}

function areaConfirm(event) {
  if (!active() || !areaViewing.has(event.player)) return false;
  const { player } = event;
  const area = areaCommon().area(areaViewing.get(player));
  if (!area) {
    player.sendMessage("Select a region first.");
    return true;
  }
  const before = progress(player).regions.length;
  TemplateWorlds.unlockRegion(player, area.key);
  const after = progress(player).regions.length;
  if (after > before) presentArea(player, area);
  sendAreaState(player);
  sendAreaOverrides(player);
  refreshPanel(player);
  return true;
}

function areaTeleport(event) {
  if (!active() || !areaViewing.has(event.player)) return false;
  const { player } = event;
  const area = areaCommon().area(areaViewing.get(player));
  if (!area) return false;
  if (!progress(player).regions.some((entry) => Rules.region(entry.id)?.area === area.id)) {
    player.sendMessage("Unlock that region before teleporting there.");
    return true;
  }
  return require("../leagueareas/Teleport.LeagueAreaUnlocks").cast(player, LEAGUE_STYLE_TYPE, area);
}

function relicCommon() {
  if (!RelicCommon.data) RelicCommon.init(api);
  return RelicCommon;
}

/**
 * The cache gives tier 1 a zero point cost, so the client treats it as available on every
 * character. Level-Up spends no points: only the tier matching the pending skill milestone
 * may look available, and every other tier stays visibly locked.
 */
function relicCostOverrides(player) {
  const catalog = relicCommon().catalog(LEAGUE_STYLE_TYPE);
  if (!catalog) return [];
  const ids = relicCommon().ids(LEAGUE_STYLE_TYPE);
  const pending = progress(player).pendingRelicMilestone === null ? -1 : pendingRelicTier(player);
  return catalog.tiers.map((tier, index) => ({
    structId: ids.tierStruct(index),
    params: { [RelicData.params.tierCost]: index === pending ? 0 : 1 },
  }));
}

function sendRelicContent(player) {
  const datasets = RelicCatalog.datasets(LEAGUE_STYLE_TYPE);
  const structs = datasets.find((dataset) => dataset.key === "structOverrides");
  if (structs) {
    const rows = new Map(structs.rows.map((row) => [row.structId, row]));
    for (const override of relicCostOverrides(player)) {
      const row = rows.get(override.structId);
      if (row) Object.assign(row.params, override.params);
      else structs.rows.push(override);
    }
  }
  player.getPacketSender().sendContentData("server", datasets);
}

function sendRelicSelections(player) {
  const Common = relicCommon();
  const picks = Common.chosen(player);
  const sender = player.getPacketSender();
  RelicData.selectionVarbits.forEach((varbit, tier) => sender.sendVarbit(varbit, picks[tier] | 0));
  RelicData.selectionOtherVarbits.forEach((varbit) => sender.sendVarbit(varbit, 0));
  RelicData.repickVarbits.forEach((varbit) => sender.sendVarbit(varbit, 0));
  sender.sendVarbit(RelicData.lastViewedVarbit, 0);
}

function openRelics(event) {
  if (!active()) return false;
  const { player } = event;
  sendRelicContent(player);
  player.getPacketSender().sendVarbit(LEAGUE_TYPE_VARBIT, LEAGUE_STYLE_TYPE);
  player.getPacketSender().sendConfig(CLAIMED_POINTS_VARP, 0);
  sendRelicSelections(player);
  api.emitCustomEvent("league:modal-opening", { player, group: RELIC_GROUP });
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(RelicData.interface.modalSize[0], RelicData.interface.modalSize[1]);
  sender.sendInterface(RELIC_GROUP);
  sender.sendInterfaceFlagsRange(uid(RELIC_GROUP, RELIC_CLICKZONES), RELIC_CLICKZONE_SLOTS[0], RELIC_CLICKZONE_SLOTS[1], FLAGS_OP1);
  sender.sendInterfaceFlagsRange(uid(RELIC_GROUP, RELIC_MENU_FRAME), RELIC_MENU_SLOTS[0], RELIC_MENU_SLOTS[1], FLAGS_OP1);
  sender.sendInterfaceFlagsRange(uid(RELIC_GROUP, RELIC_TOGGLES), -1, -1, FLAG_SCRIPT_TRIGGER);
  // The interface's own scripts write these headers while it mounts, so apply ours
  // after that first client tick rather than having them immediately overwritten.
  LeagueCommon.later(player, 1, () => sendRelicOverrides(player));
  relicViewing.set(player, -1);
  event.handled = true;
  return true;
}

function slotToRelic(catalog, sub) {
  let first = 0;
  for (let tier = 0; tier < (catalog?.tiers.length ?? 0); tier++) {
    const count = catalog.tiers[tier].relics.length;
    if (sub < first + count) return { tier, slot: sub - first + 1 };
    first += count;
  }
  return null;
}

function pendingRelicTier(player) {
  return Number(player.getAttribute("level-up:claimed-relic-milestones")?.length ?? 0);
}

function relicState(player, tier, slot) {
  const Common = relicCommon();
  const picked = Common.chosen(player)[tier];
  if (picked === slot) return RelicData.interface.viewStates.unlocked;
  if (picked !== undefined) return RelicData.interface.viewStates.tierTaken;
  if (progress(player).pendingRelicMilestone !== null && tier === pendingRelicTier(player)) {
    return RelicData.interface.viewStates.available;
  }
  return RelicData.interface.viewStates.locked;
}

function showRelic(player, index) {
  const Common = relicCommon();
  const at = slotToRelic(Common.catalog(LEAGUE_STYLE_TYPE), index);
  if (!at) return false;
  const { tier, slot } = at;
  const relic = Common.relic(LEAGUE_STYLE_TYPE, tier, slot);
  const structs = Common.structIds(LEAGUE_STYLE_TYPE, tier, slot);
  const state = relicState(player, tier, slot);
  const passive = Common.catalog(LEAGUE_STYLE_TYPE).tiers[tier]?.passive ?? "";
  relicViewing.set(player, index);
  const sender = player.getPacketSender();
  sender.sendVarbit(RelicData.lastViewedVarbit, index);
  sender.sendInterfaceScript(RelicData.interface.viewScript, [
    ...RelicData.interface.viewScriptComponents.map((child) => uid(RELIC_GROUP, child)),
    state,
    structs.relicStruct,
    structs.passiveStruct,
    String(relic.description ?? ""),
    String(passive),
  ]);
  sender.sendInterfaceScript(RelicData.interface.toggleScript, [
    ...RelicData.interface.toggleScriptComponents.map((child) => uid(RELIC_GROUP, child)), 0, 1,
  ]);
  return true;
}

function relicClicked(event) {
  if (!active() || !relicViewing.has(event.player)) return false;
  const index = Number(event.slot);
  if (!Number.isInteger(index) || index < 0) return false;
  return showRelic(event.player, index);
}

function presentRelic(player) {
  const { Animation, Graphic } = core;
  player.performAnimation(new Animation(RelicData.interface.unlockAnimation));
  player.performGraphic(new Graphic(relicCommon().league(LEAGUE_STYLE_TYPE).unlockSpotanim, 0, RelicData.interface.unlockGraphicHeight));
  player.getPacketSender().sendInterfaceRemoval();
  for (const [sound, delay] of RelicData.interface.unlockSounds) player.getPacketSender().sendSound(sound, 1, delay);
}

function relicConfirm(event) {
  if (!active() || !relicViewing.has(event.player)) return false;
  const { player } = event;
  const index = relicViewing.get(player);
  const Common = relicCommon();
  const at = slotToRelic(Common.catalog(LEAGUE_STYLE_TYPE), index);
  if (!at) {
    player.sendMessage("Select a relic first.");
    return true;
  }
  if (progress(player).pendingRelicMilestone === null) {
    player.sendMessage("You do not have an unclaimed relic milestone.");
    return true;
  }
  if (at.tier !== pendingRelicTier(player)) {
    player.sendMessage("Choose a relic from the tier you have earned.");
    return true;
  }
  const before = progress(player).relics.length;
  TemplateWorlds.unlockRelic(player, String(at.slot));
  if (progress(player).relics.length > before) {
    presentRelic(player);
    sendRelicContent(player);
    sendRelicSelections(player);
    sendRelicOverrides(player);
  }
  refreshPanel(player);
  return true;
}

function registerTaskCatalog() {
  const Tasks = require("../leaguetasks/Common.LeagueTasks");
  if (!Tasks.data) Tasks.init(api);
  const Common = mastery();
  const challenges = Common.levelUpChallenges();
  Tasks.registerCatalog(TASK_TYPE, { key: "level-up", name: "Level-Up", colour: 0xdddddd }, challenges.map((challenge, index) => ({
    id: challenge.key,
    name: challenge.text,
    description: "Combat Mastery Challenge",
    tier: 1,
    points: 1,
    area: 0,
    category: 1,
    index,
  })));
}

function answerTaskProfile(query) {
  if (active() && query?.player) query.league = TASK_TYPE;
}

function answerContentProfile(query) {
  if (active() && query?.player) query.league = TASK_TYPE;
}

function answerCompletedTasks(query) {
  if (!active() || !query?.player) return;
  query.ids = mastery().completedChallengeKeys(query.player);
}

function answerMasteryProfile(query) {
  if (active() && query?.player) query.active = true;
}

function login({ player }) {
  if (!active() || !player) return;
  sendJournalAvailability(player);
  const Points = require("../leaguemasteries/Points.LeagueCombatMasteries");
  const Unlock = require("../leaguemasteries/Unlock.LeagueCombatMasteries");
  Points.sendPoints(player);
  Points.checkCombatLevel(player);
  Unlock.sendProgress(player);
  api.emitCustomEvent("league:points-changed", { player });
  TemplateWorlds.sendLockState(player);
}

function masteryPoint({ player }) {
  if (!player) return;
  api.emitCustomEvent("league:points-changed", { player });
  sendTaskOverrides(player);
  refreshPanel(player);
}

function tasksOpened({ player }) {
  if (player) sendTaskOverrides(player);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  registerTaskCatalog();
  api.onCustomEvent("level-up:task-profile", answerTaskProfile);
  api.onCustomEvent("level-up:content-profile", answerContentProfile);
  api.onCustomEvent("level-up:completed-tasks", answerCompletedTasks);
  api.onCustomEvent("level-up:mastery-profile", answerMasteryProfile);
  api.onCustomEvent("league:mastery-point", masteryPoint);
  api.onCustomEvent("league:mastery-unlocked", masteryPoint);
  api.onCustomEvent("league:tasks-opened", tasksOpened);
  api.onCustomEvent("league:content-rows", content);
  api.onCustomEvent("world:map-flags", mapFlags);
  api.onCustomEvent("journal:tab-mounted", journalTabMounted);
  api.onCustomEvent("gameframe:ready", restoreJournal);
  api.onCustomEvent("player:bootstrap-complete", restoreJournal);
  api.onPlayerLogin(login);

  // Unit tests exercise the world rules with a deliberately small API. The screens
  // need the cache-backed area/relic data and interface hooks the live API provides.
  if (typeof pluginApi.onInterfaceActionButton !== "function") return;

  AreaCommon = require("../leagueareas/Common.LeagueAreaUnlocks");
  if (!AreaCommon.data) AreaCommon.init(api);
  AreaData = AreaCommon.data;
  RelicCommon = require("../leaguerelics/Common.LeagueRelics");
  if (!RelicCommon.data) RelicCommon.init(api);
  RelicData = RelicCommon.data;
  RelicCatalog = require("../leaguerelics/Catalog.LeagueRelics");

  api.onInterfaceActionButton([...STAT_INDEX.keys()].map((child) => uid(320, child)), statClicked);
  api.onCustomEvent("skills:stat-clicked", statOffered);

  api.onInterfaceActionButton(
    [JOURNAL.leagueTab, JOURNAL.leagueIcon].map((child) => uid(JOURNAL.group, child)),
    openJournal,
  );
  api.onInterfaceActionButton(uid(JOURNAL.panel, 40), openAreas);
  api.onInterfaceActionButton(uid(JOURNAL.panel, 44), openRelics);
  api.onInterfaceActionButton([...areaCommon().areas.values()].flatMap((area) => [area.shield, area.nameComponent]).map((child) => uid(AREA_GROUP, child)), areaShieldClicked);
  api.onInterfaceActionButton(uid(AREA_GROUP, AREA_NAME_HEADER), areaHeaderClicked);
  api.onInterfaceActionButton(uid(AREA_GROUP, AREA_CONFIRM), areaConfirm);
  api.onInterfaceActionButton(uid(AREA_GROUP, AREA_TELEPORT), areaTeleport);
  api.onInterfaceActionButton(uid(RELIC_GROUP, RELIC_CLICKZONES), relicClicked);
  api.onInterfaceActionButton(uid(RELIC_GROUP, RELIC_CONFIRM), relicConfirm);
}

module.exports = {
  attach,
  refreshPanel,
  _test: { STAT_INDEX, TASK_TYPE, CHALLENGE_ENUM, challengeEnumRow, openJournal, openAreas, openRelics },
};
