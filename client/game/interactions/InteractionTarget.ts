/**
 * The point a player turns towards when interacting with an NPC.
 *
 * NPC positions in the ECS are the centre of their footprint: for a size-n NPC the centre sits
 * n * 64 sub-tile units in from its south-west tile, and the footprint reaches n * 64 either
 * side. Facing the centre of a large NPC from alongside it turns the player diagonally, which
 * makes the same cardinal step select a back/strafe walk sequence (the "moonwalk" seen at the
 * Olm's 5x5 claws). Facing the nearest point of the footprint follows the side being attacked.
 */
export interface InteractionPoint {
    x: number;
    y: number;
}

export function nearestNpcInteractionPoint(
    selfX: number,
    selfY: number,
    centreX: number,
    centreY: number,
    size: number,
): InteractionPoint {
    const reach = Math.max(1, size | 0) << 6;
    return {
        x: Math.max(centreX - reach, Math.min(selfX, centreX + reach)),
        y: Math.max(centreY - reach, Math.min(selfY, centreY + reach)),
    };
}
