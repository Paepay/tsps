# PaeScape Issue Review Queue

Last reviewed: 2026-11-18

Repository: [`Paepay/PaeScape_Issues`](https://github.com/Paepay/PaeScape_Issues)

Statuses: `confirmed bug`, `needs repro`, `needs reporter info`, `ready to close`, `fixed locally`.

| Issue | Status | Area | Finding | Next action |
| --- | --- | --- | --- | --- |
| [#24](https://github.com/Paepay/PaeScape_Issues/issues/24) | `needs reporter info` | Teleports / Sins of the Father | Could not reproduce on the current local build. After completing Sins of the Father, both inventory Teleport and the worn Darkmeyer option reached `3592,3337`. | Ask for build, quest-journal state and whether they used inventory Teleport or the worn option. Retest against the build they used. |
| [#25](https://github.com/Paepay/PaeScape_Issues/issues/25) | `fixed locally` | Leagues / area map | The cache's areas page draws each unlocked area's map sprite from selection varbits `10662`-`10667` (script 3659). View Areas never re-sent them, so a stale client could open a map without Karamja even though the save had it. Seasonal leagues also never sent the area-count varp the patched summary reads, leaving `0/9 areas` beside a red Karamja. | Verify on the local client: unlock Karamja, reopen View Areas, relog and reopen; the Karamja overlay stays red and the summary counts it. |
| [#26](https://github.com/Paepay/PaeScape_Issues/issues/26) | `confirmed bug` | Tai Bwo Wannai Trio / world objects | Before quest completion, object `779` (Bamboo Door) is blocked by the quest. After completion the quest handler falls through, but the generic door plugin does not register `Bamboo Door`; a click moved the player without opening or toggling the door. | Add the missing open/close handling for object `779` (or its cache-derived partner) and test both sides of the door before and after completion. |
| [#27](https://github.com/Paepay/PaeScape_Issues/issues/27) | `fixed locally` | Chatbox / settings persistence | The game-chat Filter toggle is varbit `26` on varp `1055` (`chat_filter_assist`). The client did not transmit that varp and the server did not save or restore the bit, so every login reset it to On. | Verify on the local client: set Game chat to Filter, relog, and confirm it stays filtered. |
| [#28](https://github.com/Paepay/PaeScape_Issues/issues/28) | `fixed locally` | Dragon Slayer I / Duke Horacio | The quest flow works on the current build when Duke is approached on `z=1`. The reproducible defect was a full inventory: the quest announced the hand-over and showed the shield box while adding nothing. It now uses `giveItem`, reports the missing space, and ends without a false item box. | Retest with both a free slot and a full inventory. If the reporter had free slots, ask for their exact location and Dragon Slayer stage. |
| [#29](https://github.com/Paepay/PaeScape_Issues/issues/29) | `fixed locally` | Leagues / Trailblazer harpoon | Endless Harvest now keeps fishing spots, rocks and trees from depleting in Trailblazer Reloaded as well as Demonic Pacts. With Infernal Gathering on and the matching Trailblazer tool, the endless gather delivers processed output: cooked fish from the harpoon, bars from the pickaxe, and burnt logs/Firemaking XP from the axe. | Verify on the local server with Endless Harvest plus Infernal Gathering: fish with the harpoon, chop with the axe and mine with the pickaxe; each should continue without depleting and bank the doubled processed result. |
| [#30](https://github.com/Paepay/PaeScape_Issues/issues/30) | `ready to close` | Equipment / Ava's attractor | Working as intended. Ava's attractor is the sub-50 Ranged Animal Magnetism reward and has no Ranged equip requirement; Ava's accumulator is the 50 Ranged upgrade. The reported level-30 requirement belongs to neither item. | Close as not a bug and point the reporter to Ava's accumulator's level-50 requirement. |
| [#31](https://github.com/Paepay/PaeScape_Issues/issues/31) | `ready to close` | Farming / Farmer's Fortune | Working as intended. Farmer's Fortune grows farming patches instantly and never lets them catch disease. A seedling in a plant pot is not a farming patch, so its sapling timer is unchanged by the relic. | Close as not a bug; no seedling-specific change without a different source for that behavior. |

## #24 - Drakan's medallion cannot reach Darkmeyer

- Current local build, with Sins of the Father complete: inventory `Teleport` listed `Ver Sinhaza` and `Darkmeyer`; choosing Darkmeyer landed at `3592,3337`.
- The worn option also worked in the same test.
- Relevant code: `server/plugins/items/DrakansMedallion.plugin.js:51`, `server/plugins/quests/quests/SinsOfTheFather.Quest.js:3691`, and `server/tests/quest-item-teleport-rules.test.cjs:106`.
- No fix is justified yet: identify the reporter's build and exact interaction path first.

## #25 - Karamja still shown as locked on the area map

- The page's map is cache script `3659`: for each selection varbit `10662`-`10667` it sets the matching `region_data` row's map sprite on `512:22..32` (`client/tests/league-area-count.test.ts` now checks Karamja's `512:23 / 8061`).
- The server already sent those varbits at login and after an unlock's fourteen-tick delay, but View Areas opened the interface without re-sending them. `Interface.LeagueAreaUnlocks.open` now calls `Unlock.sendState`, so reopening repairs a stale client.
- Seasonal leagues never sent the area-count varp (`league-areas.json` `varps.unlockedCount`), so the patched summary read zero. `Unlock.sendState` and the unlock completion now send it; the count varp moved to `7994` because `7998` is the freeze timer's seconds (`client/game/plugins/statustimer/StatusTimerOverlay.tsx`).
- Regression coverage: `server/tests/league-areas.test.cjs` (login, reopen, unlock count) and `client/tests/league-area-count.test.ts` (Karamja's map sprite).

## #26 - Tiadeche's hut door will not open

- The quest explicitly handles only the locked case: `server/plugins/quests/quests/TaiBwoWannaiTrio.Quest.js:1181`.
- The generic door plugin registers its known door names at `server/plugins/objects/Doors.plugin.js:2221`; `Bamboo Door` is not in `DOOR_NAMES` at `Doors.plugin.js:30`.
- Live check on the current local build: before completion the click was refused; after completion the click moved the player to `2783,3057` but no door-open state or message appeared.
- Confirm whether object `779` has an open/closed cache partner around ids `778`-`781`; otherwise add explicit scene-door handling for this hut door.

## #27 - Game chat filter resets to On

- The social chat filters (`chat.filters`) already persist. This report is the separate chatbox Game chat toggle: varbit `26`, base varp `1055` (`chat_filter_assist`), bit 6.
- The client now includes varp `1055` in `client/common/vars.ts` `TRANSMIT_VARPS`, so changing the toggle sends the whole varp to the server.
- `server/plugins/interface/Settings.plugin.js` now saves only bit 6 under the existing persisted `settings:values` attribute and restores it at login with `sendVarbit(26, value)`.
- Regression coverage: `server/tests/settings-client-saves.test.cjs` and `client/tests/game-filter-varp.test.ts`.

## #28 - Anti-dragon shield from Duke Horacio

- Live reproduction on the current build succeeded on Duke's first floor at `3212,3220,1`: Dragon Slayer stage 1, talk to Duke, follow the shield conversation, receive item `1540`.
- The previously silent failure was full inventory. The hand-over branch only added the item when a slot was free but still showed the item box and the Duke's line.
- `DragonSlayer.Quest.js` now calls its `giveItem` helper. On a full inventory it shows `You need more free inventory space.` and ends the action without the false item box.
- Regression coverage: `server/tests/f2p-adventure-parity.test.cjs`, "Dragon Slayer hand-overs do not show an item box when a full inventory blocks them".

## #29 - Trailblazer harpoon and endless fishing

- Trailblazer Reloaded's Endless Harvest now keeps fishing spots, rocks and trees going, as Demonic Pacts' does. `league-relics.json` lists both leagues in `endlessLeagues`; the shared `EndlessHarvest.LeagueRelics.js` answers `fishing:continue`, `mining:deplete-rock` and `woodcutting:deplete-tree`.
- With Infernal Gathering on and the matching Trailblazer tool carried, the endless gather produces the processed output: the harpoon cooks fish (endless cooked fish), the pickaxe smelts ore into bars, and the axe burns logs for Firemaking XP. The doubled yield applies to the processed result, and Endless Harvest banks it.
- Regression coverage: `league-relic-effects-gathering.test.cjs` (processed output and depletion), `league-relic-endless-harvest-trees.test.cjs` (real fishing and woodcutting), and `league-relics-demonic-pacts.test.cjs` (both leagues' depletion behaviour).

## #30 - Ava's attractor at 1 Ranged

- OSRS awards Ava's attractor from Animal Magnetism to players below 50 Ranged and Ava's accumulator to players at 50 or above.
- Ava's attractor has no Ranged equip requirement. Ava's accumulator is the item with the level-50 requirement already present in `item-gameplay.json`.
- A player can therefore have 1 Ranged on this server if quest requirements are relaxed, but that does not make the attractor a level-30 item.
- No change.

## #31 - Seedlings in pots and Farmer's Fortune

- Farmer's Fortune grows **farming patches** instantly and prevents patch disease. It also saves planted seeds/saplings 20% of the time.
- A seedling in a plant pot is not a farming patch; its `farming:sapling-at` timer is a separate plant-pot mechanic. The relic's patch rule does not apply.
- No change: making potted seedlings instant would extend the relic beyond its documented behavior.

## Suggested Review Order

1. Verify `#27` on the local client by toggling Game chat to Filter and relogging.
2. Verify `#28` with a free slot and again with a full inventory.
3. Verify `#29` on the local server with Endless Harvest and Infernal Gathering, then close `#30` and `#31` as working as intended unless the reporters provide new reproduction details.
4. Continue the earlier queue: fix and verify `#26`, reproduce `#25` on a league world, and gather reporter details for `#24`.
