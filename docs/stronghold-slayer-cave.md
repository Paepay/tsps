# Stronghold Slayer Cave

Nieve's cave under the Tree Gnome Stronghold, entered through `slayer_cave_entrance` (26709, "Cave")
at (2428, 3423, 0), which climbs down to (2429, 9824, 0). Since the Diversed Dungeons split on
27 April 2017 the cave holds ankou, fire giants, hellhounds, bloodvelds and aberrant spectres.
Anyone may walk in; a monster can only be attacked while it is the player's current Slayer
assignment. It is not the Underground Pass, whose dungeon shares the same map rows.

**Sources:**
- **The OSRS Wiki:** [Stronghold Slayer Cave](https://oldschool.runescape.wiki/w/Stronghold_Slayer_Cave).
- **The cache:** `npc-spawns.json` (every spawn in the rectangle), `loc-teleports.json` (the
  entrance, captured four times), and the cache's map and music data ("Beneath the Stronghold").

## The cave

`server/plugins/areas/StrongholdSlayerCave.plugin.js` is an Area over x 2388-2495, y 9768-9838,
plane 0: the walkable cave reached from the bloodveld room, not Brimstail's side rooms or the
Underground Pass. Its five families and their spawn counts are the Wiki's full table:

| Monster | Spawns |
| --- | --- |
| Ankou | 8 |
| Fire giant | 12 |
| Hellhound | 13 |
| Bloodveld | 12 |
| Aberrant spectre | 13 |

The name list is exactly those five, so Brimstail and the other NPCs in the rectangle's map region
are untouched.

## Task-only attacks

- A player attack on one of the five, as `slayer:on-task` answers, is allowed only when the NPC is
  the player's task (or content counts every Slayer monster). Everything else is refused.
- **The refusal:** `You can only attack monsters that are part of your Slayer assignment.`
  The exact live line was not captured; ours.
- **Silent refusals:** as in the [Wyvern Cave](wyvern-cave.md), only the player's own pending attack
  speaks. Auto-retaliation, target scans, the dwarf cannon and the agent MCP's `can_attack` get
  `false` with nothing sent.
- A monster attacking the player is never this area's business, and an attacker outside the cave
  shooting at a monster inside it is (the target's area is asked too).

## Level-Up's region map

The Tree Gnome Stronghold is Kandarin, so the cave must be Kandarin on Level-Up worlds. The
2026-11-18 region-editor export drew Tirannwn's Underground Pass over map rows 150-153 (both its
tile rectangles and its grid), swallowing the cave below the pass. The pass's content ends by y 9718,
so `league-areas.json` now ends Tirannwn at row 151; the cave's squares fall through to their
surface squares (37-38, 52-53), which are Kandarin. `tests/league-areas.test.cjs` pins both sides.

## Not covered

- Multi-combat is not marked on this area (the Wiki says the cave is multi-combat). Attack policy is
  the only thing this Area owns for now.
- No capture exists of the entrance's refusal-free walk or of a task-only refusal; the entrance
  animation, sound and timing are the captured `loc-teleports` entry's.
