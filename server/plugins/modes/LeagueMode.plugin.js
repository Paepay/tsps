"use strict";

// The leagues the data file names, so the option's list follows the data.
const LEAGUE_OPTIONS = [
  { value: 0, label: "Not a league world" },
  ...Object.entries(require("./data/leagues.json").leagues).map(([type, league]) => ({ value: Number(type), label: league.name })),
];

function registerLateModules(api) {
  // Preserve the old second dependency pass so activity handlers keep priority.
  require("./AreaUnlocks.LeagueMode").register(api);
  require("./CombatMasteries.LeagueMode").register(api);
  require("./Pacts.LeagueMode").register(api);
}

module.exports = {
  name: "LeagueMode",
  description: "Leagues characters, progression, tasks, relics, region unlocks, combat masteries, Demonic Pacts and rewards.",
  config: {
    "league:type": {
      type: "enum", label: "League", default: 0, values: LEAGUE_OPTIONS,
      help: "Runs this world as a league: every login is the account's league character, kept apart from its main save. Not a league world is a normal world. The list follows data/leagues.json. Restart to change.",
    },
    "league:start": {
      type: "date", label: "League start date", defaultText: "Not set",
      help: "When the league began, as YYYY-MM-DD. Sets the client's league clock.",
    },
    "league:end": {
      type: "date", label: "League end date", defaultText: "Not set",
      help: "When the league ends, as YYYY-MM-DD. The welcome message then shows how many days remain.",
    },
    "league:relics": {
      type: "boolean", label: "Relics", default: true,
      help: "League relics: the relic interface, choices and their effects. On for existing worlds; turn off to run the league without relics. Restart to change.",
    },
    "league:relic-tiers": {
      type: "json", label: "Relic tiers", defaultText: "The league's own relic catalog",
      help: "A world-configured mixed-league catalog: 1-8 tiers, each 2 or 3 source-qualified relic ids such as \"4:endless-harvest\". Tier costs and passives stay the base league's. An invalid catalog is refused whole and the league's own catalog stays. Restart to change.",
    },
  },
  members: true,
  register(api) {
    require("./Base.LeagueMode").register(api);
    require("./Points.LeagueMode").register(api);
    require("./Relics.LeagueMode").register(api);
    require("./Tasks.LeagueMode").register(api);
  },
  registerDeferred: registerLateModules,
};
