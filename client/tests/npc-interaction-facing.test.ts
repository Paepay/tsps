import { strict as assert } from "node:assert";

import { nearestNpcInteractionPoint } from "../game/interactions/InteractionTarget";
import { faceAngleRs } from "../rs/utils/rotation";

const TILE = 128;
const EAST = 1536;
const WEST = 512;

/**
 * A size-5 NPC (the Great Olm's claws) has its centre 5*64 from the south-west tile and reaches
 * 5*64 either way. A player alongside it must face the near edge, not the distant centre: the
 * latter turned them diagonally so an eastward step played the backwards walk sequence.
 */
function facesTheNearEdgeOfALargeNpc(): void {
    const anchorX = 40 * TILE;
    const anchorY = 40 * TILE;
    const centreX = anchorX + 5 * 64;
    const centreY = anchorY + 5 * 64;

    const playerWest = { x: anchorX - 64, y: centreY };
    const westEdge = nearestNpcInteractionPoint(playerWest.x, playerWest.y, centreX, centreY, 5);
    assert.deepEqual(westEdge, { x: centreX - 5 * 64, y: playerWest.y });
    assert.equal(faceAngleRs(playerWest.x, playerWest.y, westEdge.x, westEdge.y), EAST, "west of the claw: face east");

    const playerEast = { x: anchorX + 5 * TILE + 64, y: centreY };
    const eastEdge = nearestNpcInteractionPoint(playerEast.x, playerEast.y, centreX, centreY, 5);
    assert.deepEqual(eastEdge, { x: centreX + 5 * 64, y: playerEast.y });
    assert.equal(faceAngleRs(playerEast.x, playerEast.y, eastEdge.x, eastEdge.y), WEST, "east of the claw: face west");

    // A player on the diagonal still faces the near corner, one cardinal step at a time.
    const southWest = { x: anchorX - 64, y: anchorY - 64 };
    const corner = nearestNpcInteractionPoint(southWest.x, southWest.y, centreX, centreY, 5);
    assert.deepEqual(corner, { x: centreX - 5 * 64, y: centreY - 5 * 64 });
}

/** Size-1 NPCs keep the old behaviour: the centre is the only point inside the footprint. */
function smallNpcsAreUnchanged(): void {
    const centreX = 20 * TILE + 64;
    const centreY = 20 * TILE + 64;
    const player = { x: 19 * TILE + 64, y: centreY };
    const edge = nearestNpcInteractionPoint(player.x, player.y, centreX, centreY, 1);
    assert.deepEqual(edge, { x: centreX - 64, y: centreY });
    assert.equal(faceAngleRs(player.x, player.y, edge.x, edge.y), EAST, "size-1 facing is unchanged");
    assert.deepEqual(nearestNpcInteractionPoint(centreX, centreY, centreX, centreY, 1), { x: centreX, y: centreY });
}

facesTheNearEdgeOfALargeNpc();
smallNpcsAreUnchanged();
