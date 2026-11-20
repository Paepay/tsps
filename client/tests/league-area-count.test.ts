import { strict as assert } from "node:assert";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { IndexType } from "../rs/cache/IndexType";
import { parseScriptFromBytes } from "../rs/cs2/Script";
import { Opcodes } from "../rs/cs2/Opcodes";
import { applyLeagueAreaCount, LEAGUE_AREA_COUNT_VARP } from "../rs/cs2/leagueAreaCount";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

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

console.log("league-area-count.test.ts: all tests passed");
