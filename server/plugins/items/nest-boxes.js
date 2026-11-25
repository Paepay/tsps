/**
 * The nest boxes Wyson gives for noted mole parts (Wiki "Nest box", Update "Content Poll 25 -
 * Batch 1": a box holds any number of nests, and a trade needs at most three free slots for the
 * seed, ring and empty boxes). One box holds every nest of one kind from a single trade.
 *
 * Contents live in the box item's metadata so they survive banking and logout:
 *   { nest: <bird nest item id>, count: <nests held> }
 */
const NEST_BOX_META = "wyson:nest-box";

/** The three live boxes, by the nest they hold. */
function boxType(core, nestId) {
  const ids = core.ItemIdentifiers;
  switch (nestId) {
    case ids.BIRD_NEST_12: return { nestId, boxId: ids.NEST_BOX_SEEDS__4, label: "seed" };
    case ids.BIRD_NEST_5: return { nestId, boxId: ids.NEST_BOX_RING_, label: "ring" };
    case ids.BIRD_NEST_6: return { nestId, boxId: ids.NEST_BOX_EMPTY_, label: "empty" };
    default: return null;
  }
}

/** The live box item id's nest type, or null for a discontinued/unknown box. */
function boxContentsType(core, boxId) {
  const ids = core.ItemIdentifiers;
  if (boxId === ids.NEST_BOX_SEEDS__4) return boxType(core, ids.BIRD_NEST_12);
  if (boxId === ids.NEST_BOX_RING_) return boxType(core, ids.BIRD_NEST_5);
  if (boxId === ids.NEST_BOX_EMPTY_) return boxType(core, ids.BIRD_NEST_6);
  return null;
}

/** `{ nest, count }` from a box's metadata, or null when it holds no valid contents. */
function boxContents(item) {
  const value = item?.getMetaValue?.(NEST_BOX_META);
  const count = Math.floor(Number(value?.count));
  if (!Number.isInteger(value?.nest) || !Number.isFinite(count) || count < 0) return null;
  return { nest: value.nest, count };
}

/** A new box item holding `count` nests of `nestId`, or null when there is nothing to hold. */
function makeBox(core, nestId, count) {
  const type = boxType(core, nestId);
  if (!type || count <= 0) return null;
  return new core.Item(type.boxId, 1).setMetaValue(NEST_BOX_META, { nest: nestId, count });
}

/** Replaces a box's held count, keeping its nest type. */
function setBoxCount(item, count) {
  const held = boxContents(item);
  if (!held) return false;
  item.setMetaValue(NEST_BOX_META, { nest: held.nest, count });
  return true;
}

module.exports = { NEST_BOX_META, boxType, boxContentsType, boxContents, makeBox, setBoxCount };
