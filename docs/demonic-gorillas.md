# Demonic and tortured gorillas

The Crash Site Cavern's demonic gorillas (level 275) and level 141 tortured gorillas. Rules come from the Wiki ([Demonic gorilla](https://oldschool.runescape.wiki/w/Demonic_gorilla), [its strategies](https://oldschool.runescape.wiki/w/Demonic_gorilla/Strategies), [Tortured gorilla](https://oldschool.runescape.wiki/w/Tortured_gorilla)). Ids, animations, projectiles, sounds and timings come from rsprox captures (recordings 3342, rev 235, and 1149, rev 237).

Both recordings are from Leagues/event worlds, so they set ids and timings only; the rules follow the Wiki.

| NPC | Ids | Protects against |
| --- | --- | --- |
| Demonic gorilla, first colour | 7144 / 7145 / 7146 | Melee / Ranged / Magic |
| Demonic gorilla, second colour | 7147 / 7148 / 7149 | Melee / Ranged / Magic |
| Tortured gorilla (level 141) | 7150, 7151 | nothing |

The ids 7152 and 7153 have no Attack option (cutscene copies). The quest's level 142 tortured gorillas (7095-7097) only punch, so they keep the default combat.

## Before

They spawned with their stats and drops but fought as ordinary NPCs:
- one style only;
- no protection prayers;
- no boulder;
- the human block and death animations.

## Combat

`server/plugins/npcs/DemonicGorillas.plugin.js`, units in `server/plugins/npcs/demonicgorillas/`.

- **Attack styles:** one style at a time, every 5 ticks: Melee, Ranged or Magic. It starts on a random one.
  - After **three missed hits** in that style (tortured gorillas: four) it says "Rhaaaaaaa!" and changes to one of the other two, at random.
  - A miss is a hit that does no damage, whether the player prayed against it or not.
- **Protection prayer (demonic only):** a hit in the style it protects against does nothing, from players, thralls or allies alike.
  - Verac's set gets through (its roll hook marks the hit), and so do the ancient mace and dragon sword specials, which pierce NPC melee prayers since the [22 October 2025 update](https://oldschool.runescape.wiki/w/Update:Grid_Master_Rewards,_Poll_%26_New_Player_Improvements). Other special attacks don't.
  - It changes prayer after **four damaging hits and 70 damage** in styles it isn't protecting against, counted together. It then protects against the style of the hit that took it over.
  - It switches by becoming its colour's other id, so the cache draws the overhead icon (sprite 440, index 0/1/2), as live does.
  - On the switch tick it plays `demonic_gorilla_smash_chest` (7228). In the captures every switch shows it, and nothing else.
  - Hits are checked when queued (a blocked hit gives no XP) and again when they land: a hit already in flight when it switches does nothing.
- **Boulder (demonic, Ranged or Magic only):** instead of an attack, it beats its chest (7228) and a rock falls from above onto the target's tile.
  - It lands 5 ticks later and takes a third of the current hitpoints (rounded down) from **every** player still on that tile. Damage is settled after that tick's step, so the rock misses a player who steps off as it lands (the graphic and the step reach the client together, #151).
  - A boulder alone can't kill, and it isn't one of the three misses.
- **Anti-safespot:** a gorilla in Melee that can't reach its target changes style.
- **Aggression:** the cavern's gorillas are aggressive until the player has completed Monkey Madness II. The cavern is an `Area`, which answers this and counts the anti-safespot ticks for its own NPCs only.
- **Multi-way combat:** two `multi-combat` zones in `server/data/definitions/world.json` cover the cavern past the archway:
  - the northern passage and rooms: x 2050-2167, y 5666-5695;
  - the western room and its passage north: x 2050-2089, y 5640-5665.
  The entrance, the passage at y 5659 and the middle room stay single-way (Wiki: "Past this archway, the entire area is exclusively multi-way").
  - The edges come from the captures: the multi-way icon (varbit 4605) against the player's tile, 1,245 tiles across both recordings, none outside these zones. The archway is the walled passage at x 2155-2156, y 5663-5665; the icon is off at y 5665 and on at 5667.
  - The rest of each edge follows the cavern's walls, so it isn't more exact than the captures need.
- **Exit rope** (28687, by the entrance): Climb-up takes you out to the cavern entrance at 2026, 5611, the tile captured players enter from. A `loc-teleports.json` entry; no capture climbs it, so its animation and timing are those of the captured Climb-up ropes.
- **Dwarf cannon:** already can't target demonic gorillas (`NO_CANNON_NPCS`).

## From the captures

| | Ids | Timing |
| --- | --- | --- |
| Melee | `demonic_gorilla_punch` 7226, sound 3350 | the hit lands on the attack tick |
| Ranged | `demonic_gorilla_range` 7227, projectile `mm2_gorilla_stone` 1302 | starts at cycle 46, lands at 46 + 5 a tile, heights 80 → 0, angle 5, progress 64 |
| Ranged impact | `mm2_gorilla_stonesplat` 1303 on the ground, sound 3191 | both delayed to the landing |
| Magic | `demonic_gorilla_magic` 7225, projectile `mm2_gorilla_spell` 1304, cast sound 3529 | starts at cycle 46, lands at 46 + 4 a tile, heights 80 → 70 |
| Magic impact | `mm2_gorilla_spellsplat` 1305 (height 70), sound 3528 | both delayed to the landing |
| Boulder | `myarm_rock_roc_travel` 856, from a tile beside the target's (east or west) | cycles 15 → 150, heights 600 → 10, angle 10 |
| Boulder landing | `castlewars_catapult_splash` 305 at height 10, area sound 1444 (radius 10) | 5 ticks after the throw |
| Block, death | `demonic_gorilla_defend` 7224, `demonic_gorilla_death` 7229, death sound 3351 | drops 2 ticks after death |

- **Hit splats and sounds:** the splat and the impact sound go out with the attack, timed to the projectile's landing. The hit lands on tick `floor(landing / 30)`, at least 1.
- **Respawn:** 100 ticks (Wiki).

## Estimates (not on the Wiki or in the captures)

- **Ranged and Magic reach:** 7 tiles.
- **Boulder frequency:** 1 in 5 of its Ranged and Magic attacks.
- **Anti-safespot delay:** 10 ticks (two attack cycles) in Melee without reaching its target.
- **Tortured gorillas' attacks:** they use the demonic gorillas' animations, projectiles and sounds. They share the model rig (same idle and walk), but no capture shows them attacking.
- **"Dealt damage four times":** read as four damaging hits; zeros don't count.
- **Missed hits add up within a style:** a hit in between doesn't reset the count. The Wiki says "after missing three hits", but its worked example has three in a row.

## Not covered

- **"The third attack must be prayed correctly":** the strategies page says a gorilla changes style consistently only when the third miss was prayed against. Any third miss counts here.
- **The style-change scream:** the Wiki mentions a "bone-chilling scream", but no sound id for it shows in the captures; only the overhead text is sent.
