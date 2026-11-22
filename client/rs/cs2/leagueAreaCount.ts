import { Opcodes } from "./Opcodes";
import { assembleRs2asm } from "./rs2asm";
import type { Script } from "./Script";

/**
 * Level-Up can unlock nine areas (Misthalin plus the eight milestones), while the
 * cache's Raging Echoes scripts only know five unlock slots and hardcode "/5".
 * The server sends the real count in this varp; script 3658 prints it instead.
 * 7994 is unused: 7990-7993 are the buff timers, 7995 the 317 gameframe,
 * 7996-7997 poison, and 7998-7999 the freeze timer.
 */
export const LEAGUE_AREA_COUNT_VARP = 7994;

/**
 * The Areas map (script 3659) can only read the cache's six selection varbits, so
 * later Level-Up unlocks have no sprite. Those varbits are all fields of varp 2801
 * (`LEAGUE_AREAS`), so the mask needs a free varp of its own. 7989 is unused:
 * no cache script or varbit uses 7000-7989, the Grand Exchange varps stop at 7955,
 * and the server's timers take 7990-7993, its area count 7994, its gameframe 7995,
 * and poison/freeze 7996-7999. Level-Up sends the bitmask here.
 */
export const LEAGUE_AREA_MASK_VARP = 7989;

const AREA_SELECTION_VARBITS = [10662, 10663, 10664, 10665, 10666, 10667];
const SCRIPT_AREA_COUNT = 3658;
const SCRIPT_AREA_MAP = 3659;
const SCRIPT_AREA_SLOT_SCRIPTS = new Set([3682, 7650]);
const SCRIPT_AREA_SLOT = 9471;
const SIXTH_AREA_VARBIT = AREA_SELECTION_VARBITS[5];

/**
 * Script 3659 draws the Areas map: for each selection varbit it takes the area id,
 * resolves its map widget (7618) and sprite (7617), then sets the sprite. Those
 * six slots stay exactly as the cache has them; the appended loop also reads the
 * Level-Up area bitmask so every possible unlock (area ids 1-21) can draw.
 */
const AREA_MAP_SOURCE = `.id 3659
.int_arg_count 0
   get_varbit              10662
   invoke                  7618
   istore                  0
   get_varbit              10663
   invoke                  7618
   istore                  1
   get_varbit              10664
   invoke                  7618
   istore                  2
   get_varbit              10665
   invoke                  7618
   istore                  3
   get_varbit              10666
   invoke                  7618
   istore                  4
   get_varbit              10667
   invoke                  7618
   istore                  5
   get_varbit              10662
   invoke                  7617
   istore                  6
   get_varbit              10663
   invoke                  7617
   istore                  7
   get_varbit              10664
   invoke                  7617
   istore                  8
   get_varbit              10665
   invoke                  7617
   istore                  9
   get_varbit              10666
   invoke                  7617
   istore                  10
   get_varbit              10667
   invoke                  7617
   istore                  11
   iload                   0
   iconst                  -1
   if_icmpeq               SLOT_0_DONE
   iload                   6
   iconst                  -1
   if_icmpeq               SLOT_0_DONE
   iload                   6
   iload                   0
   if_setgraphic           0
SLOT_0_DONE:
   iload                   1
   iconst                  -1
   if_icmpeq               SLOT_1_DONE
   iload                   7
   iconst                  -1
   if_icmpeq               SLOT_1_DONE
   iload                   7
   iload                   1
   if_setgraphic           0
SLOT_1_DONE:
   iload                   2
   iconst                  -1
   if_icmpeq               SLOT_2_DONE
   iload                   8
   iconst                  -1
   if_icmpeq               SLOT_2_DONE
   iload                   8
   iload                   2
   if_setgraphic           0
SLOT_2_DONE:
   iload                   3
   iconst                  -1
   if_icmpeq               SLOT_3_DONE
   iload                   9
   iconst                  -1
   if_icmpeq               SLOT_3_DONE
   iload                   9
   iload                   3
   if_setgraphic           0
SLOT_3_DONE:
   iload                   4
   iconst                  -1
   if_icmpeq               SLOT_4_DONE
   iload                   10
   iconst                  -1
   if_icmpeq               SLOT_4_DONE
   iload                   10
   iload                   4
   if_setgraphic           0
SLOT_4_DONE:
   iload                   5
   iconst                  -1
   if_icmpeq               SLOT_5_DONE
   iload                   11
   iconst                  -1
   if_icmpeq               SLOT_5_DONE
   iload                   11
   iload                   5
   if_setgraphic           0
SLOT_5_DONE:
   get_varp                7989
   istore                  12
   iconst                  1
   istore                  13
MASK_LOOP:
   iload                   13
   iconst                  21
   if_icmpgt               MASK_END
   iload                   12
   iload                   13
   testbit
   iconst                  1
   if_icmpne               MASK_NEXT
   iload                   13
   invoke                  7618
   istore                  14
   iload                   13
   invoke                  7617
   istore                  15
   iload                   14
   iconst                  -1
   if_icmpeq               MASK_NEXT
   iload                   15
   iconst                  -1
   if_icmpeq               MASK_NEXT
   iload                   15
   iload                   14
   if_setgraphic           0
MASK_NEXT:
   iload                   13
   iconst                  1
   add
   istore                  13
   jump                    MASK_LOOP
MASK_END:
   return`;

/**
 * Cache script 9471 maps a selection slot's struct to the area that slot stands for.
 * It only knows Raging Echoes/Demonic Pacts' start (struct 5971 -> Varlamore); the
 * area page and the relic panel also ask it about Trailblazer Reloaded and Level-Up
 * (types 4 and 5), whose defaults are Misthalin (5971 -> 1) and Karamja (5972 -> 2).
 * Later slots stay unknown: those leagues fill them with arbitrary regions, which
 * the server already sends in the selection varbits.
 */
const AREA_SLOT_SOURCE = `.id 9471
.int_arg_count 1
   get_varbit              10032
   iconst                  6
   if_icmpeq               RAGING_ECHOES
   get_varbit              10032
   iconst                  4
   if_icmpeq               KARAMJA_AVAILABLE
   get_varbit              10032
   iconst                  5
   if_icmpeq               KARAMJA_AVAILABLE
   iload                   0
   iconst                  5971
   if_icmpeq               MISTHALIN
   iconst                  -1
   return
MISTHALIN:
   iconst                  1
   return
KARAMJA_AVAILABLE:
   iload                   0
   iconst                  5971
   if_icmpeq               MISTHALIN
   iload                   0
   iconst                  5972
   if_icmpeq               KARAMJA
   iconst                  -1
   return
KARAMJA:
   iconst                  2
   return
RAGING_ECHOES:
   iload                   0
   iconst                  5971
   if_icmpeq               VARLAMORE
   iload                   0
   iconst                  5972
   if_icmpeq               KARAMJA
   iconst                  -1
   return
VARLAMORE:
   iconst                  21
   return`;

/** Replace the script's instructions with its assembled source. */
function replaceScript(script: Script, source: string): void {
    const rebuilt = assembleRs2asm(source);
    script.instructions = rebuilt.instructions;
    script.intOperands = rebuilt.intOperands;
    script.stringOperands = rebuilt.stringOperands;
    script.longOperands = rebuilt.longOperands;
    script.switches = rebuilt.switches;
    script.localIntCount = rebuilt.localIntCount;
    script.localObjCount = rebuilt.localObjCount;
    script.localLongCount = rebuilt.localLongCount;
}

/** Replace 9471's type-6-only Karamja mapping with one that also serves types 4 and 5. */
function fixAreaSlots(script: Script): void {
    replaceScript(script, AREA_SLOT_SOURCE);
}

/** Draw every area in the Level-Up bitmask after the cache's six selection slots. */
function fixAreaMap(script: Script): void {
    replaceScript(script, AREA_MAP_SOURCE);
}

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
    else if (script.id === SCRIPT_AREA_SLOT) fixAreaSlots(script);
    else if (script.id === SCRIPT_AREA_MAP) fixAreaMap(script);
    return script;
}
