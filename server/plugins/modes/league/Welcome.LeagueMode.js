/**
 * The welcome screen's message of the week on a league world, as captured (227/00196): "Welcome to
 * Old School RuneScape: <league>!" and, when world.json's pluginConfig `league:end` (an ISO date)
 * says when the league ends, the days left in it. WelcomeScreen says when it is up.
 */
const Common = require("./Common.LeagueMode");
/** The welcome screen's message of the week (welcome_screen:motw, 378:6) on a league world, as
 * captured (227/00196): the league's name and, when world.json's pluginConfig `league:end` (an ISO
 * date) is set, the days left. */
const WELCOME = {
  motw: [378, 6],
  colour: "670e3b",
  text: "Welcome to Old School RuneScape: <col={colour}>{league}</col>!",
  remaining: "<br>There are <col={colour}>{days} days remaining</col> in this League.",
  remainingOne: "<br>There is <col={colour}>1 day remaining</col> in this League.",
};

/** world.json pluginConfig: when the league ends (an ISO date). */
const END_CONFIG = "league:end";
const DAY = 86400000;

function uid([group, child]) {
  return (group << 16) | child;
}

/** The message for a league, with the days left until `end` (ms) when it is known and still ahead. */
function messageOfTheWeek(type, end, now = Date.now()) {
  const { welcome } = data;
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
  let text = fill(welcome.text, { colour: welcome.colour, league: Common.league(type).name });
  if (Number.isFinite(end) && end > now) {
    const days = Math.ceil((end - now) / DAY);
    text += fill(days === 1 ? welcome.remainingOne : welcome.remaining, { colour: welcome.colour, days });
  }
  return text;
}

function shown({ player }) {
  const type = player ? Common.leagueOf(player) : null;
  if (type === null) return;
  const end = Date.parse(String(Common.api.getPluginConfig(END_CONFIG, "")));
  player.getPacketSender().sendString(messageOfTheWeek(type, end), uid(WELCOME.motw));
}

module.exports = function attach(api) {
  api.onCustomEvent("welcome-screen:shown", shown);
};

module.exports.messageOfTheWeek = messageOfTheWeek;
