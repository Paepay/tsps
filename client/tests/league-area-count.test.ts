import { strict as assert } from "node:assert";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { IndexType } from "../rs/cache/IndexType";
import { parseScriptFromBytes } from "../rs/cs2/Script";
import { Opcodes } from "../rs/cs2/Opcodes";
import { applyLeagueAreaCount, LEAGUE_AREA_COUNT_VARP, LEAGUE_AREA_MASK_VARP } from "../rs/cs2/leagueAreaCount";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import { createCacheVm } from "../scripts/cache/cs2-sweep";

const caches = loadCacheInfos();
const cacheInfo = loadCacheList(caches).latest;
const loaded = loadCache(cacheInfo);
const cacheSystem = CacheSystem.fromFiles(cacheInfo, loaded.files);
const index = cacheSystem.getIndex(IndexType.DAT2.clientScript);
const script = (id: number) => {
    const file = index.getArchive(id)?.getFile(0);
    assert.ok(file?.data, `cache script ${id}`);
    return applyLeagueAreaCount(parseScriptFromBytes(id, file!.data, cacheSystem.decodeProfile));
};

for (const id of [3682, 7650]) {
    const patched = script(id);
    const switchMap = patched.switches?.[0];
    const switchIndex = patched.instructions.indexOf(Opcodes.SWITCH);
    const fifthOffset = switchMap?.get(5);
    assert.ok(switchIndex >= 0 && fifthOffset !== undefined, `script ${id} has a sixth case`);
    const target = switchIndex + 1 + fifthOffset!;
    assert.equal(patched.instructions[target], Opcodes.GET_VARBIT);
    assert.equal(patched.intOperands[target], 10667, `script ${id} reads the sixth selection varbit`);
}

const summary = script(3658);
assert.equal(summary.stringOperands.includes("/5 areas."), false, "the hardcoded five-area total is gone");
assert.ok(summary.stringOperands.filter((text) => text === "/9 areas.").length >= 2);
assert.ok(summary.stringOperands.includes("You have unlocked 9/9 areas!"));
const countReads = summary.instructions.reduce((count, opcode, at) =>
    count + (opcode === Opcodes.GET_VARP && summary.intOperands[at] === LEAGUE_AREA_COUNT_VARP ? 1 : 0), 0);
assert.ok(countReads >= 3, "both summaries and the full message read the server's real count");
const full = summary.stringOperands.indexOf("You have unlocked 9/9 areas!");
assert.ok(Array.from(summary.instructions.slice(full - 4, full)).includes(Opcodes.GET_VARP));
assert.equal(summary.intOperands[full - 3], 9, "the full branch compares against all nine areas");

assert.equal(LEAGUE_AREA_COUNT_VARP, 7994, "the area count has its own varp");
assert.notEqual(LEAGUE_AREA_COUNT_VARP, 7998, "it must not overwrite the freeze timer's seconds");

// Script 9471 maps a selection slot's struct to its area (the area page and the relic
// panel's next-area text). The cache only links Misthalin/Karamja for Raging Echoes'
// old start; Trailblazer Reloaded and Level-Up use types 4 and 5 with that same start.
const LEAGUE_TYPE_VARBIT = 10032;
const SCRIPT_AREA_SLOT = 9471;
const patchedSlot = script(SCRIPT_AREA_SLOT);
assert.equal(patchedSlot.instructions[0], Opcodes.GET_VARBIT);
assert.equal(patchedSlot.intOperands[0], LEAGUE_TYPE_VARBIT);

const { vm } = createCacheVm();
const areaSlot = (leagueType: number, structId: number) => {
    vm.context.varManager.setVarbit(LEAGUE_TYPE_VARBIT, leagueType);
    vm.intStackSize = 0;
    vm.run(vm.context.loadScript(SCRIPT_AREA_SLOT), [structId], []);
    return vm.intStack[0];
};
for (const leagueType of [4, 5]) {
    assert.equal(areaSlot(leagueType, 5971), 1, "type " + leagueType + " maps Misthalin");
    assert.equal(areaSlot(leagueType, 5972), 2, "type " + leagueType + " maps Karamja");
    assert.equal(areaSlot(leagueType, 5973), -1, "type " + leagueType + " leaves later slots unknown");
}
assert.equal(areaSlot(6, 5971), 21, "Demonic Pacts keeps Varlamore as its starting area");
assert.equal(areaSlot(6, 5972), 2, "Demonic Pacts keeps Karamja as its first pick");
assert.equal(areaSlot(2, 5971), 1, "other league types keep the cache's Misthalin mapping");
assert.equal(areaSlot(2, 5972), -1, "other league types keep the cache's unknown Karamja");

// The areas page's map is script 3659: it draws each unlocked area's map sprite on
// the region_data row's map component (512:22..32). The first six slots come from
// the cache's selection varbits; the patched script also reads the Level-Up area
// bitmask so the seventh and later unlocks draw too.
const MAP_SCRIPT = 3659;
const mapVm = createCacheVm();
const mapWidgets: any = mapVm.vm.context.widgetManager.getGroup(512);
const cacheInt = (scriptId: number, arg: number) => {
    mapVm.vm.intStackSize = 0;
    mapVm.vm.stringStackSize = 0;
    mapVm.vm.run(mapVm.vm.context.loadScript(scriptId), [arg], []);
    return mapVm.vm.intStack[0];
};
// 7618 resolves an area id to its map widget; 7617 resolves its map sprite.
const mapWidgetUid = (area: number) => cacheInt(7618, area);
const mapSprite = (area: number) => cacheInt(7617, area);
const slots = [1, 2, 3, 4, 5, 6];
slots.forEach((area, slot) => mapVm.vm.context.varManager.setVarbit(10662 + slot, area));
const laterAreas = [7, 8, 11, 20, 21];
assert.equal(LEAGUE_AREA_MASK_VARP, 7989, "the map mask has a free varp");
mapVm.vm.context.varManager.setVarp(
    LEAGUE_AREA_MASK_VARP,
    laterAreas.reduce((mask, area) => mask | (1 << area), 0),
);
mapVm.vm.intStackSize = 0;
mapVm.vm.run(script(MAP_SCRIPT), [], []);
for (const area of [...slots, ...laterAreas]) {
    const widget = mapWidgets.widgetsByUid.get(mapWidgetUid(area));
    assert.ok(widget, `area ${area}'s map widget exists`);
    assert.equal(widget.spriteId, mapSprite(area), `area ${area}'s map is drawn`);
}

console.log("league-area-count.test.ts: all tests passed");
