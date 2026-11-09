// The trials' scoreboards (rsprox, recordings 856 and 3778): View opens the statistics (933) as a
// main modal with the trial's title, the player's best times and this server's totals: all
// completions, completions that reached each rank, and the best time at each rank. The totals are
// kept in data/saves/barracuda-trials.json (written to a temp file, then renamed).
const fs = require("node:fs");
const path = require("node:path");
const common = require("./Common.BarracudaTrials");
const worldData = require("../../../persistence/WorldData");

const GROUP = 933;
const MAIN_MODAL = (161 << 16) | 16;
/** sailing_bt_statistics_rank_icon: the board's picture (rsprox 856, 907). */
const SCRIPT_RANK_ICON = 8620;
const RANK_ICON = 7037;
const SCRIPT_MAINMODAL_OPEN = 2524;
/** Component ids of the values, by what they show (933's labels). */
const FIELD = { title: 7, completions: 10, sharks: 12, pbSwordfish: 14, pbShark: 16, pbMarlin: 18, swordfishes: 20, marlins: 22, bestSwordfish: 24, bestShark: 26, bestMarlin: 28 };
const SCOREBOARDS = { 58926: "tempor_tantrum", 58927: "jubbly_jive", 58928: "gwenith_glide" };

let FILE = path.join(process.cwd(), "data", "saves", "barracuda-trials.json");
let saved;

// A hosted world keeps the totals in the platform's world-state document instead of
// a file beside server.exe (task10 section 8).
const STORE_KEY = "barracuda-trials";

function records() {
  if (saved) return saved;
  if (worldData.isHosted()) {
    const source = worldData.read(STORE_KEY);
    const next = source.value && typeof source.value === "object" ? source.value : {};
    if (source.loaded) saved = next;
    return next;
  }
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    saved = {};
  }
  return saved;
}

function save() {
  try {
    if (worldData.isHosted()) {
      worldData.write(STORE_KEY, records());
      return;
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(records()));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (error) {
    console.warn("[barracuda-trials] could not save the scoreboard", error);
  }
}

function trialRecord(trial) {
  const all = records();
  all[trial.key] ??= { completions: 0, ranks: [0, 0, 0], best: [0, 0, 0] };
  return all[trial.key];
}

/** A completion: counted, and its time if it reached its rank and beat the server's best. */
function record({ trial, rank, ticks, achieved }) {
  const entry = trialRecord(trial);
  if (achieved) {
    // Live's total is exactly the three ranks' counts added up (the Jubbly Jive's board).
    entry.completions++;
    entry.ranks[rank - 1]++;
    if (entry.best[rank - 1] === 0 || ticks < entry.best[rank - 1]) entry.best[rank - 1] = ticks;
  }
  save();
}

function time(ticks) {
  return ticks > 0 ? common.formatTicks(ticks) : "-";
}

function count(value) {
  return value.toLocaleString("en-GB");
}

function show(player, trial) {
  const entry = trialRecord(trial);
  const pbs = common.trialProgress(player, trial).pbs;
  const out = player.getPacketSender();
  out.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -1]);
  player.setInterfaceId(GROUP);
  out.sendSubInterface(MAIN_MODAL, GROUP, 0);
  const set = (field, text) => out.sendString(text, (GROUP << 16) | FIELD[field]);
  set("title", `The ${trial.name} Statistics`);
  set("completions", count(entry.completions));
  set("swordfishes", count(entry.ranks[0]));
  set("sharks", count(entry.ranks[1]));
  set("marlins", count(entry.ranks[2]));
  set("pbSwordfish", time(pbs[0]));
  set("pbShark", time(pbs[1]));
  set("pbMarlin", time(pbs[2]));
  set("bestSwordfish", time(entry.best[0]));
  set("bestShark", time(entry.best[1]));
  set("bestMarlin", time(entry.best[2]));
  out.sendInterfaceScript(SCRIPT_RANK_ICON, [RANK_ICON]);
}

function view(event) {
  const key = SCOREBOARDS[event.objectId];
  if (!key || event.clickType !== 1) return;
  event.handled = true;
  require("./Run.BarracudaTrials").stopBoat(event.player);
  show(event.player, common.trialByKey(key));
}

function attach(api) {
  common.init(api);
  api.onObjectInteraction(view);
  api.setUsableFromDeck?.(["Scoreboard"]);
  api.onCustomEvent("barracuda-trials:completed", record);
}

module.exports = attach;
module.exports.record = record;
module.exports.show = show;
module.exports.setFile = (file) => { FILE = file; saved = undefined; };
