package gateway.cache

import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * Cache script 7656 answers "is this Combat Mastery challenge complete?" for the challenge
 * list on interface 311. It switches on the challenge struct's position in enum 5695 and knows
 * only the ten cache point-unlock varbits (11585-11594). Level-Up lists twelve challenges in
 * that enum, so positions 11 and 12 (`deal-50-in-one-hit`, `combat-skill-99`) fell through to
 * the default and always drew as incomplete after their point was awarded.
 *
 * The browser client applies the same patch from `client/rs/cs2/masteryChallengeRows.ts`. Both
 * read the league task completion bits the server already mirrors every mastery challenge into:
 * Level-Up catalog positions 10 and 11 are bits 10 and 11 of varp 2616. Raging Echoes never
 * reaches the new cases: its enum keeps the cache's ten entries.
 *
 * The patch is guarded by the script's SHA-256, so another cache revision keeps its own script
 * instead of receiving instructions fitted to this one.
 */
object ClientScriptPatches {
    const val CLIENT_SCRIPT_ARCHIVE = 12
    const val MASTERY_CHALLENGE_GROUP = 7656

    private const val EXPECTED_SHA256 = "bda834f5ad3905861ece9a15ada6ac62bd57687244f4c7cccecb63b7d10f87a6"
    private const val SWITCH_AT = 52
    private const val FIRST_CASE = 54
    private const val CASE_STRIDE = 7
    private const val FALLBACK_AT = 124
    private const val OPCODES_BEFORE_PATCH = 130
    private const val TASK_COMPLETION_VARP = 2616
    private const val SWITCH_OPCODE = 60
    private const val JUMP_OPCODE = 6
    private const val GET_VARP_OPCODE = 1
    private const val ICONST_OPCODE = 0
    private const val TESTBIT_OPCODE = 4010
    private const val RETURN_OPCODE = 21
    private const val GET_VARBIT_OPCODE = 25
    private const val ILOAD_OPCODE = 33
    private const val IF_ICMPGE_OPCODE = 32
    private val EXTRA_BITS = intArrayOf(10, 11)

    /** Returns [data] unchanged when it is not the script this patch was made for. */
    fun masteryChallengeRows(data: ByteArray): ByteArray {
        if (sha256(data) != EXPECTED_SHA256) return data
        val script = decode(data)
        require(script.opcodes == OPCODES_BEFORE_PATCH) { "script 7656 has ${script.opcodes} opcodes" }
        require(script.switches.size == 1) { "script 7656 has ${script.switches.size} switches" }
        val table = script.switches[0]
        require(table.size == 10) { "script 7656's switch has ${table.size} cases" }
        require(script.opcodeAt(SWITCH_AT) == SWITCH_OPCODE) { "no switch at $SWITCH_AT" }
        require(script.opcodeAt(SWITCH_AT + 1) == JUMP_OPCODE && script.intAt(SWITCH_AT + 1) == 70) { "default case changed" }
        for (index in 0 until 10) {
            val at = FIRST_CASE + index * CASE_STRIDE
            require(table[index + 1] == at - SWITCH_AT - 1) { "case ${index + 1} moved" }
            require(script.opcodeAt(at) == GET_VARBIT_OPCODE && script.intAt(at) == 11585 + index) { "case ${index + 1} no longer reads its varbit" }
            require(script.opcodeAt(at + 1) == ILOAD_OPCODE && script.intAt(at + 1) == 4) { "case ${index + 1} changed" }
            require(script.opcodeAt(at + 2) == IF_ICMPGE_OPCODE) { "case ${index + 1} changed" }
        }
        for (at in FALLBACK_AT until OPCODES_BEFORE_PATCH step 2) {
            require(script.opcodeAt(at) == ICONST_OPCODE && script.intAt(at) == 0 && script.opcodeAt(at + 1) == RETURN_OPCODE) {
                "the fallback changed"
            }
        }

        val out = ByteArrayOutputStream(data.size + EXTRA_BITS.size * 18 + 16)
        out.write(data, 0, script.instructionsEnd)
        for (bit in EXTRA_BITS) {
            out.writeOpcode(GET_VARP_OPCODE)
            out.writeInt(TASK_COMPLETION_VARP)
            out.writeOpcode(ICONST_OPCODE)
            out.writeInt(bit)
            out.writeOpcode(TESTBIT_OPCODE)
            out.write(0)
            out.writeOpcode(RETURN_OPCODE)
            out.write(0)
        }
        out.writeInt(script.opcodes + EXTRA_BITS.size * 4)
        out.write(data, script.instructionsEnd + 4, 12)
        out.write(1) // one switch block
        out.writeShort(table.size + EXTRA_BITS.size)
        val pairs = LinkedHashMap(table)
        EXTRA_BITS.forEachIndexed { index, _ ->
            pairs[11 + index] = OPCODES_BEFORE_PATCH + index * 4 - SWITCH_AT - 1
        }
        for ((key, offset) in pairs) {
            out.writeInt(key)
            out.writeInt(offset)
        }
        out.writeShort(switchBlockLength(pairs.size))
        return out.toByteArray()
    }

    private fun switchBlockLength(cases: Int) = 1 + 2 + cases * 8

    private class Decoded(
        val opcodes: Int,
        val instructionsEnd: Int,
        val opcodeOffsets: IntArray,
        val operands: IntArray,
        val switches: List<Map<Int, Int>>,
    ) {
        fun opcodeAt(index: Int) = opcodeOffsets[index]
        fun intAt(index: Int) = operands[index]
    }

    private fun decode(data: ByteArray): Decoded {
        val switchLength = u16(data, data.size - 2)
        val end = data.size - 2 - switchLength - 16
        val opcodes = i32(data, end)
        var at = data.indexOf(0).let { if (it < 0) error("script has no name terminator") else it + 1 }
        val opcodeOffsets = IntArray(opcodes)
        val operands = IntArray(opcodes)
        for (index in 0 until opcodes) {
            opcodeOffsets[index] = u16(data, at)
            at += 2
            when (val opcode = opcodeOffsets[index]) {
                3 -> { while (data[at] != 0.toByte()) at++; at++ }
                61 -> at += 8
                21, 38, 39, 62, 63 -> { operands[index] = data[at].toInt() and 0xff; at++ }
                else -> {
                    if (opcode < 100) { operands[index] = i32(data, at); at += 4 }
                    else { operands[index] = data[at].toInt() and 0xff; at++ }
                }
            }
        }
        check(at == end) { "instructions end at $at, not $end" }
        val switches = ArrayList<Map<Int, Int>>()
        at = end + 16
        val blocks = data[at++].toInt() and 0xff
        repeat(blocks) {
            val count = u16(data, at); at += 2
            val table = LinkedHashMap<Int, Int>()
            repeat(count) { table[i32(data, at)] = i32(data, at + 4); at += 8 }
            switches += table
        }
        check(at == data.size - 2) { "switch block ends at $at" }
        return Decoded(opcodes, end, opcodeOffsets, operands, switches)
    }

    private fun u16(data: ByteArray, at: Int) = ((data[at].toInt() and 0xff) shl 8) or (data[at + 1].toInt() and 0xff)
    private fun i32(data: ByteArray, at: Int) =
        (u16(data, at) shl 16) or u16(data, at + 2)

    private fun ByteArrayOutputStream.writeOpcode(opcode: Int) {
        write(opcode ushr 8)
        write(opcode)
    }

    private fun ByteArrayOutputStream.writeInt(value: Int) {
        write(value ushr 24)
        write(value ushr 16)
        write(value ushr 8)
        write(value)
    }

    private fun ByteArrayOutputStream.writeShort(value: Int) {
        write(value ushr 8)
        write(value)
    }

    private fun sha256(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
