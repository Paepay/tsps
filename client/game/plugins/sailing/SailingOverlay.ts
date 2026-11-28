import type { SceneGeometry, SceneLoc } from "../../scene/SceneGeometry";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";
import { convexHull } from "../npcindicators/npcMatching";
import type { SailingHighlight, SailingHighlightKind, SailingPlugin } from "./SailingPlugin";

type Rgba = [number, number, number, number];
type Point = [number, number];
type Shape = { points: Point[]; stroke: Rgba; fill?: Rgba; width: number; closed: boolean };

function rgba(argb: number): Rgba {
    const value = argb >>> 0;
    return [
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255,
        (value >>> 24) / 255,
    ];
}

/** A translucent fill of a category's border colour (the rooftop overlay's default fill alpha). */
function fillOf(border: number): Rgba {
    const fill = rgba(border);
    fill[3] *= 0.25;
    return fill;
}

/**
 * Draws the Sailing highlights: a clickbox around each shipwreck, charting marker and port board,
 * plus a line along each nearby charted route. Clickboxes use the object model's world-space
 * bounds (the same projection Object Markers uses); a loc without a model falls back to its tile.
 */
export class SailingOverlay implements WidgetOverlay {
    readonly drawBelowWidgets = true;
    private shapes?: Shape[];
    private previousShapes: Shape[] = [];
    private revision = 0;

    constructor(private readonly plugin: SailingPlugin) {}

    signature(): string {
        this.shapes = this.build();
        if (!sameShapes(this.shapes, this.previousShapes)) this.revision++;
        this.previousShapes = this.shapes;
        return this.shapes.length === 0 ? "" : String(this.revision);
    }

    draw(context: WidgetOverlayDrawContext): { x: number; y: number; w: number; h: number }[] {
        const shapes = this.shapes ?? this.build();
        this.shapes = undefined;
        const glr: any = context.renderer;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of shapes) {
            glr.drawPolyline?.(shape.points, shape.width, shape.stroke, shape.closed);
            if (shape.fill) glr.drawPolygon?.(shape.points, shape.fill);
            for (const [x, y] of shape.points) {
                minX = Math.min(minX, x - shape.width);
                minY = Math.min(minY, y - shape.width);
                maxX = Math.max(maxX, x + shape.width);
                maxY = Math.max(maxY, y + shape.width);
            }
        }
        return Number.isFinite(minX) ? [{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }] : [];
    }

    private build(): Shape[] {
        const plugin = this.plugin;
        if (!plugin.isStarted() || !plugin.isLoggedIn()) return [];
        const geometry = plugin.getClient().sceneGeometry;
        if (!geometry) return [];
        const shapes: Shape[] = [];
        for (const object of plugin.objects) {
            const color = this.color(object.kind);
            const points = this.clickbox(geometry, object.loc) ?? this.tile(geometry, object.loc);
            if (points) shapes.push({ points, stroke: rgba(color), fill: fillOf(color), width: 2, closed: true });
        }
        const routeColor = Number(plugin.config.routeColor()) >>> 0;
        for (const route of plugin.routes) {
            const points: Point[] = [];
            for (const [x, y] of route.points) {
                const centerX = x + 0.5, centerY = y + 0.5;
                const point = geometry.worldToScreen(centerX, geometry.tileHeight(centerX, centerY, route.plane), centerY);
                if (point) points.push([point[0], point[1]]);
            }
            if (points.length >= 2) {
                shapes.push({ points, stroke: rgba(routeColor), width: 2, closed: false });
            }
        }
        return shapes;
    }

    private color(kind: SailingHighlightKind): number {
        const config = this.plugin.config;
        switch (kind) {
            case "shipwreck":
            case "sunken":
                return Number(config.shipwreckColor()) >>> 0;
            case "charting":
                return Number(config.chartingColor()) >>> 0;
            case "board":
                return Number(config.boardColor()) >>> 0;
        }
    }

    private clickbox(geometry: SceneGeometry, loc: SceneLoc): Point[] | undefined {
        const parts = geometry.locModelPoints(loc);
        if (!parts || parts.length === 0) return undefined;
        let x0 = Infinity, x1 = -Infinity, h0 = Infinity, h1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const part of parts) {
            for (const [x, h, y] of part) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                h0 = Math.min(h0, h);
                h1 = Math.max(h1, h);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
        if (!Number.isFinite(x0)) return undefined;
        const projected: Point[] = [];
        for (const x of [x0, x1]) {
            for (const h of [h0, h1]) {
                for (const y of [y0, y1]) {
                    const point = geometry.worldToScreen(x, h, y);
                    if (point) projected.push([point[0], point[1]]);
                }
            }
        }
        if (projected.length < 3) return undefined;
        const hull = convexHull(projected);
        return hull.length >= 3 ? hull : undefined;
    }

    /** A one-tile outline for locs whose model is missing or fully transparent. */
    private tile(geometry: SceneGeometry, loc: SceneLoc): Point[] | undefined {
        const points: Point[] = [];
        for (const [x, y] of [[loc.tileX, loc.tileY], [loc.tileX + 1, loc.tileY], [loc.tileX + 1, loc.tileY + 1], [loc.tileX, loc.tileY + 1]]) {
            const height = geometry.tileHeight(x, y, loc.plane, loc.tileX + 0.5, loc.tileY + 0.5);
            const point = geometry.worldToScreen(x, height, y);
            if (!point) return undefined;
            points.push([point[0], point[1]]);
        }
        return points;
    }
}

function sameShapes(a: readonly Shape[], b: readonly Shape[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i], right = b[i];
        if (left.width !== right.width || left.closed !== right.closed || left.points.length !== right.points.length) return false;
        for (let c = 0; c < 4; c++) {
            if (left.stroke[c] !== right.stroke[c]) return false;
            if ((left.fill?.[c] ?? -1) !== (right.fill?.[c] ?? -1)) return false;
        }
        for (let p = 0; p < left.points.length; p++) {
            if (Math.round(left.points[p][0]) !== Math.round(right.points[p][0]) ||
                Math.round(left.points[p][1]) !== Math.round(right.points[p][1])) return false;
        }
    }
    return true;
}

export type { SailingHighlight };
