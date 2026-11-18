import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFromPayload } from "../common/gamemode/GamemodeContentStore";
import { Opcodes } from "../rs/cs2/Opcodes";
import { createCacheVm } from "../scripts/cache/cs2-sweep";

// Script 7656 finds a challenge struct in enum 5695 and switches on its position. The cache's
// ten cases read the point-unlock varbits 11585-11594. Level-Up's enum has twelve rows, so the
// patch appends two cases reading the league task completion varp (2616) bits 10 and 11.
const CHALLENGE_QUERY = 7656;
const CHALLENGE_ENUM = 5695;
const TASK_COMPLETION_VARP = 2616;
const SWITCH_AT = 52;

function query(vm: any, structId: number): number {
    vm.intStackSize = 0;
    vm.run(vm.context.loadScript(CHALLENGE_QUERY), [structId], []);
    return vm.intStack[0];
}

test("script 7656 learns Level-Up's two extra challenge rows", () => {
    const { scripts } = createCacheVm();
    const script = scripts.load(CHALLENGE_QUERY);
    assert.equal(script.instructions.length, 138, "130 cache instructions plus two four-instruction cases");
    assert.equal(script.instructions[130], Opcodes.GET_VARP);
    assert.equal(script.intOperands[130], TASK_COMPLETION_VARP);
    assert.equal(script.intOperands[131], 10, "the eleventh row tests task bit 10");
    assert.equal(script.instructions[134], Opcodes.GET_VARP);
    assert.equal(script.intOperands[135], 11, "the twelfth row tests task bit 11");
    const table = script.switches?.[0];
    assert.ok(table);
    assert.equal(table.size, 12);
    assert.equal(table.get(1), 1, "the cache's first case is unchanged");
    assert.equal(table.get(10), 1 + 9 * 7);
    assert.equal(table.get(11), 130 - SWITCH_AT - 1);
    assert.equal(table.get(12), 134 - SWITCH_AT - 1);
});

test("the cache's ten rows still answer from their point-unlock varbits", () => {
    const { vm } = createCacheVm();
    const enumType = vm.context.enumTypeLoader.load(CHALLENGE_ENUM);
    assert.equal(enumType.keys.length, 10, "the cache enum is the Raging Echoes list");
    enumType.keys.forEach((_, index) => {
        const structId = enumType.intValues[index];
        const threshold = vm.context.structTypeLoader.load(structId)?.params?.get(2029) ?? 1;
        vm.context.varManager.setVarbit(11585 + index, threshold);
        assert.equal(query(vm, structId), 1, `row ${index + 1} is complete at its threshold`);
        vm.context.varManager.setVarbit(11585 + index, threshold - 1);
        assert.equal(query(vm, structId), 0, `row ${index + 1} is incomplete below it`);
    });
});

test("Level-Up's eleventh and twelfth rows follow the task completion varp", () => {
    loadFromPayload({
        gamemodeId: "level-up",
        datasets: [{
            key: "enumOverrides",
            rows: [{
                enumId: CHALLENGE_ENUM,
                valueType: "J",
                defaultValue: -1,
                entries: [
                    [1, 1177], [2, 1178], [3, 1179], [4, 1180], [5, 1181], [6, 1182], [7, 1186],
                    [8, 207800], [9, 207801], [10, 207802], [11, 207803], [12, 207804],
                ],
            }],
        }],
    });
    const { vm } = createCacheVm();
    const [fifty, ninetyNine] = [207803, 207804];

    vm.context.varManager.setVarp(TASK_COMPLETION_VARP, 0);
    assert.equal(query(vm, fifty), 0);
    assert.equal(query(vm, ninetyNine), 0);

    vm.context.varManager.setVarp(TASK_COMPLETION_VARP, 1 << 10);
    assert.equal(query(vm, fifty), 1, "deal-50-in-one-hit appears complete");
    assert.equal(query(vm, ninetyNine), 0, "combat-skill-99 is still open");

    vm.context.varManager.setVarp(TASK_COMPLETION_VARP, (1 << 10) | (1 << 11));
    assert.equal(query(vm, ninetyNine), 1, "combat-skill-99 appears complete too");
});