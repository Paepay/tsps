import { strict as assert } from "node:assert";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../rs/config/loctype/LocModelLoader";
import { LocLoadType, SceneBuilder } from "../rs/scene/SceneBuilder";
import { getIdFromTag } from "../rs/scene/entity/EntityTag";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import {
    ROOFTOP_AREAS,
    ROOFTOP_COURSES,
    collectRooftopObstacles,
} from "../game/plugins/rooftopagility/RooftopObstacles";
import type { SceneLoc } from "../game/scene/SceneGeometry";

/**
 * The catalog and the loaded-scene boxes must match the cache's real rooftop spawns. The older
 * regression test only compared ids with the server course files, so a missing map placement or a
 * clickbox that never left the player's plane still passed.
 */
const info = loadCacheList(loadCacheInfos()).latest;
const cache = loadCache(info);
const factory: any = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
const locTypes = factory.getLocTypeLoader();
const locModels = new LocModelLoader(
    locTypes,
    factory.getModelLoader(),
    factory.getTextureLoader(),
    factory.getSeqTypeLoader(),
    factory.getSeqFrameLoader(),
    factory.getSkeletalSeqLoader(),
);
const builder = new SceneBuilder(
    info,
    factory.getMapFileLoader(),
    factory.getUnderlayTypeLoader(),
    factory.getOverlayTypeLoader(),
    locTypes,
    locModels,
    cache.xteas,
);
function checkArea(courseArea: (typeof ROOFTOP_AREAS)[number], obstacleIds: readonly number[]) {
    const padding = 4;
    const baseX = courseArea.minX - padding;
    const baseY = courseArea.minY - padding;
    const sizeX = courseArea.maxX - courseArea.minX + 1 + padding * 2;
    const sizeY = courseArea.maxY - courseArea.minY + 1 + padding * 2;
    const scene = builder.buildScene(baseX, baseY, sizeX, sizeY, false, LocLoadType.NO_MODELS);

    const placedIds = new Set<number>();
    const originTiles = new Map<string, SceneLoc[]>();
    for (let plane = 0; plane < 4; plane++) {
        for (let x = 0; x < sizeX; x++) {
            for (let y = 0; y < sizeY; y++) {
                const tile = scene.tiles[plane]?.[x]?.[y];
                if (!tile) continue;
                const entries = [tile.wall, tile.wallDecoration, tile.floorDecoration, ...tile.locs]
                    .filter(Boolean) as any[];
                for (const entry of entries) {
                    const id = getIdFromTag(entry.tag);
                    placedIds.add(id);
                    // SdMapDataLoader registers a loc only at its centre origin (loc.startX/startY).
                    const isLoc = tile.locs.includes(entry);
                    const localX = isLoc ? entry.startX : x;
                    const localY = isLoc ? entry.startY : y;
                    if (isLoc && (localX !== x || localY !== y)) continue;
                    const key = `${baseX + localX},${baseY + localY},${plane}`;
                    const entriesAtOrigin = originTiles.get(key) ?? [];
                    entriesAtOrigin.push({
                        id,
                        tileX: baseX + localX,
                        tileY: baseY + localY,
                        plane,
                        shape: (entry.flags ?? 0) & 0x3f,
                        rotation: ((entry.flags ?? 0) >> 6) & 3,
                    });
                    originTiles.set(key, entriesAtOrigin);
                }
            }
        }
    }

    const geometry = {
        locsAtTile: (x: number, y: number, plane: number): SceneLoc[] => {
            return (originTiles.get(`${x},${y},${plane}`) ?? []).filter((loc) => obstacleIds.includes(loc.id));
        },
    };
    const found = collectRooftopObstacles(geometry, baseX, baseY, Math.max(sizeX, sizeY));
    return { placedIds, found, foundIds: new Set(found.map((loc) => loc.id)) };
}

for (const course of ROOFTOP_COURSES) {
    const areas = ROOFTOP_AREAS.filter((courseArea) => courseArea.course === course.name);
    assert.ok(areas.length > 0, `${course.name} has a loaded-scene area`);
    const placedIds = new Set<number>();
    const foundIds = new Set<number>();
    let foundAbovePlaneZero = false;
    for (const courseArea of areas) {
        const checked = checkArea(courseArea, course.obstacles);
        for (const id of checked.placedIds) placedIds.add(id);
        for (const id of checked.foundIds) foundIds.add(id);
        foundAbovePlaneZero ||= checked.found.some((loc) => loc.plane > 0);
    }
    for (const id of course.obstacles) {
        assert.ok(placedIds.has(id), `${course.name}: ${id} is placed in the cache inside its areas`);
        assert.ok(foundIds.has(id), `${course.name}: ${id} is collected from the loaded planes`);
    }
    assert.ok(foundAbovePlaneZero, `${course.name}: obstacles above plane 0 are collected`);
}

console.log("rooftop agility cache coverage passed");
