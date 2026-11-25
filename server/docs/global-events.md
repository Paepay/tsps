# Global Events

`Paepay/tsps#65` adds world-wide combat, skilling and utility events. One event may run in each
category at a time. The catalog lives in
`server/plugins/events/global/data/global-events.json`; the website, token store and account
preferences are the sibling change `Paepay/PaeScape_Realms#110`.

## Authority

The platform is the **only** writer of activations, timers, token balances and account
preferences. A hosted world:

- reads `GET /api/server/events` after startup, login/reconnect and before the Events UI opens;
- applies the returned effect descriptors locally;
- never activates, extends or clears an event itself;
- stops applying an event at its `endsAt` even if the next refresh has not arrived.

Standalone worlds keep a local preview in `data/saves/global-events.json` for `::globalevent`
testing. That path is never used when a platform URL is configured.

## Catalog

The names, summaries and effect parameters are the frozen contract from
`PaeScape_Realms#110`.

| Category | Event | Effect kind |
| --- | --- | --- |
| Combat | Berserker | `perfect-accuracy` melee, PvM only |
| Combat | Deadeye | `perfect-accuracy` ranged, PvM only |
| Combat | Mystique | `perfect-accuracy` magic, PvM only |
| Combat | Onslaught | `pvm-max-hit` x1.5, all styles |
| Combat | Bloodthirst | `blood-fury`, all styles, PvM only |
| Skilling | Endless Harvest | `gather-to-bank` |
| Skilling | Abundance | `double-resources`, XP for the extra resources |
| Skilling | Infernal Gathering | burn logs, smelt ore, cook fish |
| Skilling | Production Master | `instant-production` |
| Skilling | Trickster | guaranteed Thieving/Hunter success, temporary Sage's greaves (e) |
| Utility | Rags to Riches | `unique-drop-chance` x1.1 |
| Utility | Accelerate | `xp-multiplier` x2, all sources |
| Utility | Prodigy | `visible-level-boost` +12 each tick |
| Utility | Banker's Note | temporary Banker's note (e) |
| Utility | Master's Arsenal | temporary Best-in-Slot loadout |

Every row carries `"pvp": false`. Effect multipliers are read from the platform's `effect`
descriptor when the platform sends one, with the catalog value as the fallback.

## PvP exclusion

No event affects player-versus-player gameplay:

- Combat accuracy, Bloodthirst and Onslaught require `target.isNpc()`.
- Prodigy neither boosts nor rests stats while the player is fighting a player or in a PvP area.
- Rags to Riches only changes unique NPC/boss/raid tables; Accelerate only changes XP.
- A Master's Arsenal loan sets PvP damage to zero (`onCombatHitDamage`), while keeping its normal
  PvM mechanics.

## Production Master coverage

`instant-production` makes each eligible make-X loop process the whole inventory: Smithing
(smelting, smithing, cannonballs), Cooking, Crafting (leather, jewellery, battlestaves, pottery,
gems, amethyst, glassblowing, spinning), Fletching (logs, shields, stringing, chisel, bolt tips,
arrows, bolts, tipped bolts, darts) and Herblore (cleaning and mixing). The loop stops when its
materials or free output space run out; it never consumes the bank or invents ingredients.

Runecrafting altar crafts (including combination runes) empty the supported essence pouches that
fit into the inventory before the essence is counted, so the pouch contents are part of the same
one-click craft. Guardian essence stays in its pouch, and a pouch whose essence has nowhere to go
is left intact. Firemaking lights the whole carried log stack in the one action that starts the
fire.

## Temporary items

A temporary copy is an ordinary item carrying a `global-event` binding in its metadata:

```json
{
  "kind": "arsenal",
  "eventId": "masters-arsenal",
  "eventItemId": 1000010,
  "instanceId": "...",
  "account": "platform:<userId>",
  "worldId": "...",
  "catalog": "scythe"
}
```

The binding is what makes a copy temporary. Bound copies cannot be traded, banked, sold, alched,
listed on the GE, dropped, transformed, kept through death, or placed in the looting bag,
POH costume storage or group storage. Tradeable-only containers refuse them by their
untradeable flag as well as their binding. They are purged on login, event
end and expiry. Claiming and deleting are blocked while in combat or for 10 seconds after combat
(`combatLock.postCombatSeconds`). Master's Arsenal loans never spend charges, ammunition or runes;
their equipment level and combat gates are waived (quest, resource and activity checks still
apply), and only one loan may be held at a time.

The event's two purpose-made items are their own custom items: `Banker's note (e)` (50006, based
on the real 28767) and `Sage's greaves (e)` (50007, based on the greaves at 28771). They
deliberately do not reuse the league relic ids (`BANKERS_NOTE` 28767 and the league `Sage's
greaves` custom item 50001). `Items.GlobalEvents` validates both ids when it registers: each
must be a dedicated custom item in `50000..65022`, distinct from the other and from the league
relics, or the world fails startup with an error naming the item. Item handlers also act only
on copies carrying a live `global-event` binding, so a real relic is never mistaken for an
expired event item.

Bound copies saved before that split still carry a real or league-relic id. They are migrated,
not purged: login (and any item action that reaches the handlers) strips the stale
`global-event` binding and leaves the item as the player's real relic. Deleting those copies
would take a permanent Banker's note away from a league or Level-Up character and was the cause
of the "temporary global item ... expired" message on level-up worlds.

### Custom item ids and the 16-bit transport

The platform contract reserves item ids at **1,000,000 and above** for temporary event items. The
TSPS 317 wire protocol encodes an item id in 16 bits (`encodeItemSlot` writes
`(itemId + 1) & 0xffff`), and both custom-item registries cap ids at `65022`. A real
1,000,000+ id cannot be displayed or stored on that wire without a client protocol change.

The world therefore records a unique virtual `eventItemId >= 1_000_000` in every binding and
validates the catalog at plugin load (`Items.catalogEventItemIds()`). The granted stack keeps a
real or cache-safe `itemId` so the existing client can render it. `eventItemId` is the stable
contract identity for storage, auditing and the eventual 32-bit item transport; the wire id is
presentation only. Do not move the virtual ids onto the wire without changing both the server
encoder and the client decoder.

### Master's Arsenal loans use dedicated custom items

The nine loans (Scythe of Vitur, Twisted bow, Tumeken's shadow, Osmumten's fang, Dragon hunter
lance, Bow of Faerdhinen, infernal axe, pickaxe and harpoon) are dedicated items `50008..50016`,
each defined in `custom-items.json` with the real item as its `baseItemId`. The definitions keep
the real display name, bonuses, slot, animations and requirements, and are sent through the
existing `customItems` content packet at login. The ids are inside the client's 16-bit item range,
so no transport change is involved.

Weapon behaviour in this codebase is looked up by item id, so `Items.GlobalEvents` registers each
loan as an `ItemAliases` entry for its base id. The alias is consulted by the id-keyed tables:
`CombatSpecial.getForWeaponId` (with the fang's explicit `specialAttack.from`), `WeaponProfile`
(speed, reach, animations), `RangedWeapon`/`Ammunition`, and crystal armour's bow bonus. Plugins
that know the loan id answer first: the infernal tools are added to the Woodcutting, Mining and
Fishing tool tables with their equipment requirement waived, and their charge trackers recognise
the loan ids.

Loans never degrade into permanent items. The skilling charge event marks a loan as skipped, and
every degrade path guards `setId` rather than assuming a charged-to-uncharged mapping exists.
Item actions that would convert a loan into resources (`Uncharge`, `Dismantle`, `Disassemble`,
`Empty`, `Revert`, `Break`) and all item-on-object use are refused, so a charged loan cannot be
exchanged for runes or topped up with the player's own materials. A loan binding saved under an
older real id is purged rather than migrated: `migrateLegacy` deliberately never releases an
Arsenal binding, because that would mint a permanent weapon. Only the Banker's note's pre-split
copies are migrated back to the player's real relic.

## Opting out

The platform scopes opt-outs to **account x event id**, not to a world or one activation. The
default is enabled. The world applies the platform's `disabledEventIds` to every reward, XP,
gather, combat, conversion and temporary-item path.

An opt-out never cancels the world event, changes its timer or slot, refunds a token, or affects
another player. It only suppresses that account's benefit. The Events UI Toggle writes
`PUT /api/server/events/preferences`; a standalone preview changes the local
`global-events:disabled` attribute instead. Opting out of Master's Arsenal also removes every loan
from the inventory and equipment at once and interrupts the combat or skilling action that
depended on it; opting back in may claim one loan while the same event runs.

## Event tokens and activation

The platform owns token prices, balances and purchased durations. The world makes **one** atomic
activation call:

1. `GET /api/server/events/account?userId=...` after login/reconnect or when the UI opens.
2. `POST /api/server/events/activate` with `{ userId, eventId, idempotencyKey }`.
3. Apply the returned `events` three-slot state and `tokenBalance` locally.

There is no reservation, release or consume step. The platform checks the category slot and the
token balance inside one transaction and consumes exactly one token only when the activation
commits. A retry reuses one idempotency key per player action; the platform replies `200` with the
stored result instead of spending again.

| Status | Meaning | In-game result |
| --- | --- | --- |
| `201` / `200` | activated / idempotent replay | event applied, token count updated |
| `402` | no token for that event | `tokenNone`; nothing spent |
| `409` | slot busy or no configured duration | `eventAlreadyRunning` / `tokenNoDuration` |
| `403` | account is not a member of this world | `tokenNotMember` |
| `400` | bad event or idempotency key | `tokenBadRequest` |

The platform routes are `Paepay/PaeScape_Realms#112`; until they are deployed a hosted world
reports the token service as unavailable and never invents a free activation or duration.

## Commands and testing

- `::events` - open the Events interface (also the HUD icon's click).
- `::globalevent list` - owner-only list with ids, categories and live timers.
- `::globalevent start <event-id> <minutes>` - standalone worlds only.
- `::globalevent stop [combat|skilling|utility]` - standalone worlds only.

On a hosted world `start` and `stop` report that activation and stopping are platform-only.

Run the focused tests after `yarn build` in `server`:

```powershell
node --test tests/global-events-*.test.cjs
```

Coverage includes the frozen catalog contract, one slot per category, hosted import/clear and
local-write refusal, account x event opt-outs, atomic token activation and error mapping,
combat-only NPC effects, Master's Arsenal PvP suppression, skilling effects and temporary-item
expiry.
