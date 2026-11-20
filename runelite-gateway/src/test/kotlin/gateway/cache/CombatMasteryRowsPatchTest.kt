package gateway.cache

import gateway.headless.TestCache
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

/** The official client's challenge list gains Level-Up's eleventh and twelfth rows. */
class CombatMasteryRowsPatchTest {
    private val cache = TestCache.cache

    @Test
    fun `script 7656 gets the two task-bit cases`() {
        val patched = servedScript()
        val vanilla = requireNotNull(cache.file(ClientScriptPatches.CLIENT_SCRIPT_ARCHIVE, ClientScriptPatches.MASTERY_CHALLENGE_GROUP))
        assertEquals(vanilla.size + 36 + 16, patched.size, "eight instructions and two switch pairs")

        val switchLength = u16(patched, patched.size - 2)
        assertEquals(99, switchLength, "one block with twelve cases")
        val end = patched.size - 2 - switchLength - 16
        assertEquals(138, i32(patched, end))
        val appended = end - 36
        for ((offset, bit) in listOf(0 to 10, 18 to 11)) {
            assertEquals(1, u16(patched, appended + offset))
            assertEquals(2616, i32(patched, appended + offset + 2))
            assertEquals(0, u16(patched, appended + offset + 6))
            assertEquals(bit, i32(patched, appended + offset + 8))
            assertEquals(4010, u16(patched, appended + offset + 12))
            assertEquals(21, u16(patched, appended + offset + 15))
        }
        assertEquals(12, u16(patched, end + 17))
        val cases = (0 until 12).associate { index ->
            i32(patched, end + 19 + index * 8) to i32(patched, end + 23 + index * 8)
        }
        assertEquals(1, cases[1])
        assertEquals(64, cases[10])
        assertEquals(77, cases[11])
        assertEquals(81, cases[12])
    }

    @Test
    fun `another revision's script is left alone`() {
        val changed = requireNotNull(cache.file(ClientScriptPatches.CLIENT_SCRIPT_ARCHIVE, ClientScriptPatches.MASTERY_CHALLENGE_GROUP)).copyOf()
        changed[0] = (changed[0] + 1).toByte()
        assertSame(changed, ClientScriptPatches.masteryChallengeRows(changed))
    }

    private fun servedScript(): ByteArray {
        val client = ClientCache(cache)
        val index = ReferenceTable.decode(
            Container.decompress(
                requireNotNull(client.container(DiskStore.MASTER_ARCHIVE, ClientScriptPatches.CLIENT_SCRIPT_ARCHIVE)),
            ),
        )
        return GroupFiles.split(
            Container.decompress(requireNotNull(client.container(ClientScriptPatches.CLIENT_SCRIPT_ARCHIVE, ClientScriptPatches.MASTERY_CHALLENGE_GROUP))),
            index.groups.getValue(ClientScriptPatches.MASTERY_CHALLENGE_GROUP).files,
        ).getValue(0)
    }

    private fun u16(data: ByteArray, at: Int) = ((data[at].toInt() and 0xff) shl 8) or (data[at + 1].toInt() and 0xff)
    private fun i32(data: ByteArray, at: Int) = (u16(data, at) shl 16) or u16(data, at + 2)
}
