// #62: Level-Up plays league type 4, so every boosted-drops row must apply there.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const data = require("../plugins/modes/data/league-boosted-drops.json");
const { patternsFor } = require("../plugins/modes/league/BoostedDrops.LeagueMode");

test("every restricted source applies in Level-Up (type 4)", () => {
    const missing = data.sources.filter((source) => source.leagues && !source.leagues.includes(4)).map((source) => source.name);
    assert.deepEqual(missing, []);
});

test("later-league sources boost in type 4", () => {
    for (const source of ["Araxxor", "Araxyte", "Vardorvis", "Tormented Demon", "Branda the Fire Queen", "Moons of Peril"]) {
        assert.ok(patternsFor(4, source).length > 0, source);
    }
});

test("a row still stays out of the leagues its page did not list", () => {
    assert.equal(patternsFor(6, "Obor").length, 0);
});
