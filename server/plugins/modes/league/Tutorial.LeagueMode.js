/**
 * The league tutorial is removed (it was bugged): a league character skips it. The login sends the
 * league's finished `league_tutorial_completed` (14 in cache 242, which script 2449 answers for
 * every league type), and a character saved part way through is finished on its next login.
 * Nothing opens the tutorial's screens or walkthroughs any more; the Level-Up world has no league
 * profile and never ran it.
 *
 *   api.emitCustomEvent("league:tutorial-stage", { player })  -> stage (league_tutorial_completed)
 */
const Common = require("./Common.LeagueMode");

/**
 * Where the tutorial left every character. Cache 242's script 2449 returns 14 for every league
 * type, and the area screen compares that value (script 3719), so 12 made it warn that the
 * tutorial was incomplete while teleporting anyway (issue #23).
 */
const FINISHED = { 2: 14, 4: 14, 5: 14, 6: 14 };

/**
 * The persisted stage. No starting value is declared on purpose: a character from before the
 * tutorial had one has none, and the login answers the league's finished value either way.
 */
const STAGE_ATTRIBUTE = "league:tutorial-stage";

function finishedStage(type) {
  return FINISHED[type] ?? Common.data.tutorialCompletedValue;
}

/**
 * `league:tutorial-stage` { player } -> stage: always the league's finished value, and the saved
 * stage of a character part way through is replaced so nothing can resume it.
 */
function answerStage(query) {
  const type = query?.player ? Common.leagueOf(query.player) : null;
  if (type === null) return;
  const stage = finishedStage(type);
  query.stage = stage;
  query.player.setAttribute(STAGE_ATTRIBUTE, stage);
}

function joined({ player, league }) {
  const type = Number.isInteger(league) ? league : Common.leagueOf(player);
  if (type === null) return;
  player.setAttribute(STAGE_ATTRIBUTE, finishedStage(type));
}

module.exports = function attach(api) {
  api.persistAttribute(STAGE_ATTRIBUTE);
  api.onCustomEvent("league:joined", joined);
  api.onCustomEvent("league:tutorial-stage", answerStage);
};

module.exports.STAGE_ATTRIBUTE = STAGE_ATTRIBUTE;
module.exports.FINISHED = FINISHED;
