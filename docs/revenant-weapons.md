# Revenant weapons

`server/plugins/items/RevenantWeapons.plugin.js` covers Viggora's chainmace, the Ursine chainmace and Craw's bow. The Webweaver bow is `WebweaverBow.plugin.js` and the accursed and Thammaron's sceptres are `AccursedSceptre.plugin.js` ([Powered staves](powered-staves.md)).

**Sources:** the OSRS Wiki pages "Viggora's chainmace", "Ursine chainmace", "Craw's bow" and "Thammaron's sceptre". No rsprox recording shows these weapons, so their messages follow the captured Webweaver bow and accursed sceptre ones ("Your bow has N charges left powering it.", "Your sceptre has N charges left powering it.") with the weapon's own word (chainmace, bow, sceptre). That wording is an assumption.

## Ether
- Activated with 1,000 revenant ether (use the ether on the weapon). That is not a charge: up to 16,000 more are, so 17,000 in all.
- The ether prompt, the busy varbit and the activation and top-up messages are the Webweaver bow's:
  - "You use 1,000 ether to activate the weapon."
  - "You add a further N revenant ether to your weapon, giving it a total of N charges."
- Check: "Your chainmace has N charges left powering it." (bow: "Your bow …").
- **Uncharge** returns every ether, the activation ether included. A weapon that did not have its activation ether paid through the weapon (a shop or spawn) refunds and drops only its charges. The weapons are not sold in any shop, since an unpaid one would Uncharge and Dismantle into free ether.
- **Dismantle** on an uncharged weapon gives 7,500 revenant ether. The Ursine chainmace (u) instead splits back into Viggora's chainmace (u) and the Claws of Callisto, and the Webweaver bow (u) into Craw's bow (u) and the Fangs of Venenatis.
- Both ask on the destroy prompt first, as live does: Uncharge with "Are you sure you want to uncharge it?" / "If you uncharge this weapon, all the revenant ether will be returned to your inventory.", Dismantle with "Are you sure you want to dismantle this weapon?" and either "Your weapon will be broken down for 7500 Revenant ether." (after an objectbox naming the weapon) or "You will receive its components back.". Yes sends no chat message; a confirmed Uncharge plays the destroy sound. The Webweaver bow and the Accursed sceptre's prompts are recorded, the others follow them.

## Making the Ursine chainmace
- Use the Claws of Callisto on an uncharged Viggora's chainmace (either item can be used first). **85 Smithing** is required; below it the chat says "You need a Smithing level of 85 to do that." and nothing is used up. The chainmace becomes the Ursine chainmace (u) in place and the claws are consumed. Preset parts are refused.
- Or ask **Andros Mai** at Ferox Enclave (NPC 10388). With both items in the inventory and **500,000 coins**, his "Ask about rare item" transcript offers to combine them; the fee and claws go and the Ursine chainmace (u) arrives. He needs no Smithing level. The transcript's "If the player has enough coins" / "does not have enough coins" branches are answered from the plain coins held.
- Dismantle still splits an uncharged Ursine chainmace back into Viggora's chainmace (u) and the Claws of Callisto.

## Attacks
- Each attack spends one ether, hit or miss, in or out of the Wilderness. The chainmaces spend it as the swing starts; Craw's bow as the shot is paid.
- Emptied, a weapon stays activated. A chainmace then swings as an ordinary mace. Craw's bow needs no arrows but cannot fire without ether: "There is not enough revenant ether left powering your bow."
- **Passive:** charged, +50% accuracy and +50% damage against NPCs in the Wilderness. It does not apply to players. The last ether still gives the attack it paid for the passive.
- The passive multiplies the applicable Salve bonus. A Salve bonus and Slayer helmet bonus do not combine. For Craw's bow with an imbued Slayer helmet on task, damage adds the 50% weapon boost to the 15% task boost (33/20 total); accuracy still multiplies them. This ordering follows the [Wiki DPS calculator](https://github.com/weirdgloop/osrs-dps-calc/blob/701b2dac5264756a31b08bb3ef8e41907b3925de/src/lib/PlayerVsNPCCalc.ts). Plain/enchanted Salves affect melee; only their imbued variants also affect Ranged and Magic.

## Death
Dying to a player in the Wilderness drops all the ether to the killer even when the weapon is protected, and the weapon comes back uncharged.

## Bear Down
The Ursine chainmace's special attack (Wiki: Ursine chainmace). It needs the charged mace and 50% special energy. Accuracy is doubled and rolled against the target's slash defence. On a successful hit it deals 20 damage over 6 seconds in five red hits of 4, drains 20 Agility and stops the target running for 6 ticks (3.6 seconds). `server/plugins/combat/specials/UrsineChainmace.SpecialAttack.js`.

## Not covered
- The bank's Configure-Charges option.
- Deaths to monsters in the Wilderness: the existing Webweaver bow rule (killed by a player) is followed.
