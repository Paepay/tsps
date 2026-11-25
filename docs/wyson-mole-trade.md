# Wyson's mole-part trade

Wyson the gardener (Falador Park) trades Giant Mole parts for bird nests.
Code: `server/plugins/npcs/Wyson.plugin.js` (the trade) and
`server/plugins/skills/Woodcutting.plugin.js` (searching the nests).

## Trade

- OSRS Wiki, "Wyson the gardener" (Mole parts): one nest per mole claw or mole skin,
  five per immaculate mole skin. Each nest is a Wyson seed nest (72%), a ring nest (20%)
  or an empty nest (8%) (Mod Ash, quoted there).
- Wyson accepts noted parts too: mole claw 7417, mole skin 7419 and immaculate mole skin
  33383. The 2 October 2014 update ("Content Poll 25 - Batch 1") says noted parts are
  exchanged for nest boxes "containing the equivalent amount of bird nests", that a box
  "can hold any number of nests", and that three free inventory slots cover any number of
  parts. Ours: the trade rolls every part once, then makes one box per nest kind it
  rolled (seed 23062, ring 12794, empty 12792), each holding that kind's count. A noted
  trade with no room for the boxes it would hand over takes nothing and says "You don't
  have enough inventory space." (ours).
- The transcript's variants play: with a claw or skin in the inventory he opens with the
  trade offer; with an immaculate skin he adds "I see you also have an immaculate mole
  skin with you, ...". The trade is the variants' action step (`T0rsOq`, `XwNH58`). The
  plugin's variant hook recognises the noted ids; the transcript alone only names the
  unnoted parts.
- rsprox capture local 1000323 (revision 227), ticks 13633-13641: Talk-to, the opening
  line, the three-option menu, the player's "Okay, I will trade the mole parts.", and on
  its continue the parts (3 claws, 3 skins) come out and six nests fill the first free
  slots (14, 15, 17, 18, 20, 21; 24-26 cleared), and the chat closes. That capture is a
  Leagues world: only its `league_mole_claws_traded` varbit (0 -> 3, the claws traded) is
  Leagues-only and not reproduced; the part count is the Wiki's one nest per part.
- Unnoted parts still fill the first free inventory slots. When an immaculate skin's five
  nests do not all fit, the overflow goes into boxes (Wiki: nest boxes are given "if
  there isn't enough room in the inventory to hold all the nests"), rather than leaving
  the skin in the inventory.

## Nest boxes

- Code: `server/plugins/items/NestBox.plugin.js`; contents live in the box item's metadata
  (`wyson:nest-box`: `{ nest, count }`), so they survive banking and logout.
- `Check` shows an item box: "The nest box contains N seed/ring/empty nests." (ours: no
  capture records the live wording). `Drop` is the cache's.
- `Extract` moves the nests into the inventory; the box stays with what did not fit and
  the last nest removes it. It refuses outside a bank or the Grand Exchange with "You can
  only extract nests from a nest box inside a bank or at the Grand Exchange." (ours). The
  bank/exchange restriction is the 15 October 2018 hotfix documented on the Wiki.
- In the bank's side inventory the client labels op 9 from the box's cache param 595,
  which is "Extract" (not Wear/Wield), and `Bank.ts` sends `bank:inventory-op` before it
  would treat op 9 as an equip; the box claims that op, so the bank stays open. The GE
  interface check stays, but the client's GE side panel enables only ops 1-5 and 10, so it
  does not offer Extract itself.
- Only the live boxes are made and handled: empty 12792, seeds 23062, ring 12794. The
  discontinued 12793 and 13654 are left alone; their old seed nests are not modelled.

## Wyson seed nest (`bird_nest_decentseeds_jan2019`, 22800)

- OSRS Wiki, "Bird nest (Wyson)": its own 684-slot seed table, with quantities (6
  sweetcorn, 6 strawberry, 2 limpwurt, 2 watermelon, 2 snape grass, the rest 1), and an
  empty nest always.
- rsprox capture local 1000323, ticks 13646-13648: "You take 6 sweetcorn seeds out of the
  bird's nest.", "You take a cadantine seed out of the bird's nest." and "You take a
  Spirit Tree seed out of the bird's nest." (spam), the nest becoming an empty nest.
- rsprox capture 1002026 (revision 242), tick 31877: a magic seed reads "a Magic Tree
  seed"; the regular seed nest's line was corrected to match.

## Unrecorded wording

- The exact live Check and Extract messages, and the live refusal outside a bank/exchange,
  are not in any capture available here; the texts above are ours.
- Ours: the herb and allotment seed lines other than sweetcorn and cadantine are
  unrecorded and follow those two.
