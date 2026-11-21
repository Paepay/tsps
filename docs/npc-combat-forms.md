# NPC combat forms

Some NPCs are two cache NPCs: an idle form and a fighting form. The attack and death
sequences are rigged for the fighting form, so playing them on the idle model stretches the
mesh. Wyrms are the case that needs it:

| idle | fights as |
| --- | --- |
| 8610 Wyrm | 8611 Wyrm |
| 10398 Shadow Wyrm | 10399 Shadow Wyrm |
| 12584 Bloodthirsty Shadow Wyrm | 12585 Bloodthirsty Shadow Wyrm |

`combatForm` in `npc-combat-defs.json`, on the idle id, names the fighting id.  The fighting
id gets the same attack, block and death animations and no `combatForm` of its own.

`NPC.updateCombatForm()` swaps the NPC's transformation to the fighting id while it has a
target or an attacker, and `Combat.executeAttack` calls it before an NPC's swing, so the
client already has that model when the animation arrives.  The form stays through the death:
`NPCDeathTask` sets it before the death animation and `NPCDeathTask.remove` clears the
transformation as the NPC leaves the world.

The definition is read from the spawn id (`NPC.getDefinition()`), so the swap is one-way on
the wire: the fighting form is a transformation, and ending it clears it rather than reading
a form back from the fighting id.
