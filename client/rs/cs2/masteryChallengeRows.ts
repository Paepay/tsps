import { Opcodes } from "./Opcodes";
import type { Script } from "./Script";

/**
 * Cache script 7656 answers "is this Combat Mastery challenge complete?" for the
 * challenge list on interface 311. It finds the challenge struct's position in
 * enum 5695 and switches on it, knowing only the ten cache point-unlock varbits
 * (11585-11594). Level-Up lists twelve challenges in that enum, so positions 11
 * and 12 (`deal-50-in-one-hit` and `combat-skill-99`) fell through to the
 * default and always drew as incomplete, even after award() paid their point.
 *
 * Level-Up already mirrors every mastery challenge into the league task
 * completion varps that the task screen reads (position 10 and 11 of the
 * Level-Up catalog are bits 10 and 11 of varp 2616). The two extra switch cases
 * read those bits, so the mastery screen and the task screen agree without a
 * second completion source:
 *
 *     case 11: get_varp 2616; iconst 10; testbit; return
 *     case 12: get_varp 2616; iconst 11; testbit; return
 *
 * Raging Echoes never reaches them: its enum keeps the cache's ten entries.
 */
export const MASTERY_CHALLENGE_SCRIPT = 7656;
const TASK_COMPLETION_VARP = 2616;
const EXTRA_BITS = [10, 11] as const;

const SWITCH_AT = 52;
const FIRST_CASE = 54;
const CASE_STRIDE = 7;
const FALLBACK_AT = 124;
const OPCODES_BEFORE_PATCH = 130;
const CASE_LENGTH = 4;
const UNLOCK_BASE = 11585;

/** The appended block for a task bit: read the bit and return it. */
function caseForBit(bit: number): Array<[number, number]> {
    return [
        [Opcodes.GET_VARP, TASK_COMPLETION_VARP],
        [Opcodes.ICONST, bit],
        [Opcodes.TESTBIT, 0],
        [Opcodes.RETURN, 0],
    ];
}

/**
 * Extends script 7656's ten-case switch with the two Level-Up task bits.
 * False (unchanged) when the cache's script is not the one this patch expects.
 */
export function applyMasteryChallengeRows(script: Script): boolean {
    if (script.id !== MASTERY_CHALLENGE_SCRIPT) return false;
    const ops = script.instructions;
    const args = script.intOperands;
    const table = script.switches?.[0];
    if (!table || ops.length !== OPCODES_BEFORE_PATCH || ops[SWITCH_AT] !== Opcodes.SWITCH) return false;
    if (ops[SWITCH_AT + 1] !== Opcodes.JUMP || args[SWITCH_AT + 1] !== 70) return false;
    if (table.size !== 10) return false;

    for (let index = 0; index < 10; index++) {
        const target = FIRST_CASE + index * CASE_STRIDE;
        if (table.get(index + 1) !== target - SWITCH_AT - 1) return false;
        if (ops[target] !== Opcodes.GET_VARBIT || args[target] !== UNLOCK_BASE + index) return false;
        if (ops[target + 1] !== Opcodes.ILOAD || args[target + 1] !== 4) return false;
        if (ops[target + 2] !== Opcodes.IF_ICMPGE) return false;
    }
    for (let at = FALLBACK_AT; at < ops.length; at += 2) {
        if (ops[at] !== Opcodes.ICONST || args[at] !== 0) return false;
        if (ops[at + 1] !== Opcodes.RETURN) return false;
    }

    const appended = EXTRA_BITS.flatMap(caseForBit);
    const length = ops.length + appended.length;
    const instructions = new Int32Array(length);
    const intOperands = new Int32Array(length);
    const stringOperands = new Array<string | null>(length).fill(null);
    const longOperands = new BigInt64Array(length);
    instructions.set(ops);
    intOperands.set(args);
    stringOperands.splice(0, ops.length, ...script.stringOperands);
    longOperands.set(script.longOperands);
    appended.forEach(([opcode, operand], index) => {
        const at = ops.length + index;
        instructions[at] = opcode;
        intOperands[at] = operand;
    });

    EXTRA_BITS.forEach((_, index) => {
        const target = ops.length + index * CASE_LENGTH;
        table.set(11 + index, target - SWITCH_AT - 1);
    });

    script.instructions = instructions;
    script.intOperands = intOperands;
    script.stringOperands = stringOperands;
    script.longOperands = longOperands;
    return true;
}
