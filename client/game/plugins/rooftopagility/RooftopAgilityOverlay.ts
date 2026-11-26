import type { SceneGeometry, SceneLoc } from "../../scene/SceneGeometry";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";
import { convexHull } from "../npcindicators/npcMatching";
import type { RooftopAgilityPlugin } from "./RooftopAgilityPlugin";

type Rgba = [number, number, number, number];
type Point = [number, number];
type Shape = { points: Point[]; stroke: Rgba; fill: Rgba; width: number };

function rgba(argb: number): Rgba {
    const value = argb >>> 0;
    return [
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255,
        (value >>> 24) / 255,
    ];
}

/**
 * Draws the projected clickbox of every rooftop agility obstacle in the loaded scene, under the
 * widgets. The box is the screen hull of the model's world-space bounds, the way RuneLite builds
 * clickboxes for most objects (the same projection Object Markers uses).
 */
export class RooftopAgilityOverlay implements WidgetOverlay {
    readonly drawBelowWidgets = true;
    private shapes?: Shape[];
    private previousShapes: Shape[] = [];
    private revision = 0;

    constructor(private readonly plugin: RooftopAgilityPlugin) {}

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
            glr.drawPolyline?.(shape.points, shape.width, shape.stroke, true);
            glr.drawPolygon?.(shape.points, shape.fill);
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
        if (!plugin.isStarted() || !plugin.isLoggedIn() || !plugin.config.showClickboxes()) return [];
        const geometry = plugin.getClient().sceneGeometry;
        if (!geometry) return [];
        const stroke = rgba(Number(plugin.config.clickboxColor()) >>> 0);
        const fill = rgba(Number(plugin.config.fillColor()) >>> 0);
        const width = Math.max(0, Number(plugin.config.borderWidth()) || 0);
        const shapes: Shape[] = [];
        for (const loc of plugin.objects) {
            const points = this.clickbox(geometry, loc);
            if (points) shapes.push({ points, stroke, fill, width });
        }
        return shapes;
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
}

/** Repaint only when the rounded screen geometry or its styling changes. */
function sameShapes(a: readonly Shape[], b: readonly Shape[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i], right = b[i];
        if (left.width !== right.width || left.points.length !== right.points.length) return false;
        for (let c = 0; c < 4; c++) {
            if (left.stroke[c] !== right.stroke[c] || left.fill[c] !== right.fill[c]) return false;
        }
        for (let p = 0; p < left.points.length; p++) {
            if (Math.round(left.points[p][0]) !== Math.round(right.points[p][0]) ||
                Math.round(left.points[p][1]) !== Math.round(right.points[p][1])) return false;
        }
    }
    return true;
}
