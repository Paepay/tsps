/**
 * Removes the temporary Global Event items that were shelved with the event system.
 *
 * Event copies carried `{ "global-event": { kind, ... } }` in item metadata. The dedicated
 * Banker's note (e) and Sage's greaves (e) used ids 50006 and 50007; Master's Arsenal loans used
 * real item ids with kind "arsenal". Both are deleted on login. A real league relic that an older
 * event build accidentally bound is kept: dropping the stale metadata restores it to its ordinary
 * item instead of taking a permanent item away from the character.
 */
const BINDING_META = "global-event";
const ARSENAL_KIND = "arsenal";
const RETIRED_ITEM_IDS = new Set([50006, 50007]);

function bindingOf(item) {
  const binding = item?.getMetaValue?.(BINDING_META);
  return binding && typeof binding === "object" ? binding : null;
}

function isRetired(item) {
  return RETIRED_ITEM_IDS.has(item?.getId?.()) || bindingOf(item)?.kind === ARSENAL_KIND;
}

function removeFrom(container, item) {
  const slot = container?.getItems?.().indexOf(item) ?? -1;
  if (slot < 0) return false;
  container.deleteItem(item, slot);
  container.refreshItems?.();
  return true;
}

function containers(player) {
  return [player.getInventory(), player.getEquipment(), ...(player.getBanks?.() ?? [])].filter(Boolean);
}

function cleanup(player) {
  let removed = 0;
  let restored = 0;
  for (const container of containers(player)) {
    for (const item of [...(container.getItems?.() ?? [])]) {
      if (!bindingOf(item)) continue;
      if (isRetired(item)) {
        if (removeFrom(container, item)) removed++;
      } else {
        item.setMetaValue(BINDING_META, undefined);
        restored++;
      }
    }
  }
  if (removed > 0) player.sendMessage("Your temporary global-event items have been removed.");
  return { removed, restored };
}

function login({ player }) {
  cleanup(player);
}

module.exports = {
  name: "RetiredGlobalEventItems",
  register(api) {
    api.onPlayerLogin(login);
  },
  cleanup,
  BINDING_META,
  RETIRED_ITEM_IDS,
};
