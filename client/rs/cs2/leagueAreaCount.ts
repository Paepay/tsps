import { Opcodes } from "./Opcodes";
import type { Script } from "./Script";

/**
 * Level-Up can unlock nine areas (Misthalin plus the eight milestones), while the
 * cache's Raging Echoes scripts only know five unlock slots and hardcode "/5".
 * The server sends the real count in this varp; script 3658 prints it instead.
 */
export const LEAGUE_AREA_COUNT_VARP = 7998;

const AREA_SELECTION_VARBITS = [10662, 10663, 10664, 10665, 10666, 10667];
const SCRIPT_AREA_COUNT = 3658;
const SCRIPT_AREA_SLOT_SCRIPTS = new Set([3682, 7650]);
const SIXTH_AREA_VARBIT = AREA_SELECTION_VARBITS[5];

/** Add the cache's missing sixth selection slot to scripts 3682 and 7650. */
function addSixthAreaCase(script: Script): void {
    const switchMap = script.switches?.[0];
    if (!switchMap) return;
    const switchIndex = script.instructions.indexOf(Opcodes.SWITCH);
    const fourthCase = switchMap.get(4);
    if (switchIndex < 0 || fourthCase === undefined || switchMap.has(5)) return;
    const fifthTarget = switchIndex + 1 + fourthCase + 3;
    // The switch's default arm is the old "push 0" at that target; every real slot is
    // handled above it, so it can become slot 5 without shifting any jump offsets.
    if (script.instructions[fifthTarget] !== Opcodes.ICONST || script.intOperands[fifthTarget] !== 0) return;
    script.instructions[fifthTarget] = Opcodes.GET_VARBIT;
    script.intOperands[fifthTarget] = SIXTH_AREA_VARBIT;
    switchMap.set(5, fourthCase + 3);
}

/** Script 3658's counter: read the server's real unlocked count, with a nine-area total. */
function fixAreaSummary(script: Script): void {
    for (let i = 0; i < script.stringOperands.length; i++) {
        if (script.stringOperands[i] === "/5 areas.") script.stringOperands[i] = "/9 areas.";
        if (script.stringOperands[i] === "You have unlocked 5/5 areas!") {
            script.stringOperands[i] = "You have unlocked 9/9 areas!";
        }
    }

    // The two "You have unlocked X/9 areas." messages convert the count right before joining.
    for (let i = 1; i < script.instructions.length; i++) {
        if (script.instructions[i] !== Opcodes.TOSTRING) continue;
        if (script.instructions[i - 1] === Opcodes.ILOAD && script.intOperands[i - 1] === 42) {
            script.instructions[i - 1] = Opcodes.GET_VARP;
            script.intOperands[i - 1] = LEAGUE_AREA_COUNT_VARP;
        }
    }

    const fullMessage = script.stringOperands.indexOf("You have unlocked 9/9 areas!");
    if (fullMessage < 0) return;
    for (let i = fullMessage - 1; i >= Math.max(0, fullMessage - 6); i--) {
        if (script.instructions[i] === Opcodes.ILOAD && script.intOperands[i] === 42) {
            script.instructions[i] = Opcodes.GET_VARP;
            script.intOperands[i] = LEAGUE_AREA_COUNT_VARP;
            if (script.instructions[i + 1] === Opcodes.ICONST) script.intOperands[i + 1] = 9;
            break;
        }
    }
}

export function applyLeagueAreaCount(script: Script): Script {
    if (SCRIPT_AREA_SLOT_SCRIPTS.has(script.id)) addSixthAreaCase(script);
    else if (script.id === SCRIPT_AREA_COUNT) fixAreaSummary(script);
    return script;
}
