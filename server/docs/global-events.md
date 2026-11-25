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
listed on the GE, dropped, transformed or kept through death. They are purged on login, event
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

### Why Master's Arsenal loans keep real item ids

The nine loans (Scythe of vitur, Twisted bow, Tumeken's shadow, Osmumten's fang, Dragon hunter
lance, Bow of Faerdhinen, infernal axe, pickaxe and harpoon) use their real item ids plus the
binding, not new `50008..50016` definitions. A custom definition inherits stats, appearance and
animations, but weapon behaviour in this codebase is looked up by exact item id: the twisted
bow's scaling (`isUsingTwistedBow`), the shadow's charge and multiplier, the scythe/fang special
attacks (`CombatSpecial.getForWeaponId`) and every charge tracker all compare the equipped id.
A loan on a new id would therefore lose its special attack and its normal PvM mechanics; the
contract's preserve-special-attacks rule is the stronger one.

Revisit this only together with a base-id resolver for item behaviour (definition `baseItemId`
consulted by the weapon plugins and by `CombatSpecial.getForWeaponId`), and then register the
nine definitions and their `specialAttack.from` rows in the same change.

## Opting out

The platform scopes opt-outs to **account x event id**, not to a world or one activation. The
default is enabled. The world applies the platform's `disabledEventIds` to every reward, XP,
gather, combat, conversion and temporary-item path.

An opt-out never cancels the world event, changes its timer or slot, refunds a token, or affects
another player. It only suppresses that account's benefit. The Events UI Toggle writes
`PUT /api/server/events/preferences`; a standalone preview changes the local
`global-events:disabled` attribute instead.

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
