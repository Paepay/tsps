import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { runeliteImage } from "@runelite/client/ui/runeliteImages";
import type { SidebarStore } from "./SidebarStore";

/** How near the game's right edge the pointer must be to show the arrow (ClientUI: 15 + 10). */
const NEAR_EDGE = 25;

/**
 * RuneLite's sidebar arrow when it has no custom title bar: drawn at the game view's top-right,
 * shown while the pointer is near that edge, and clicking it hides or shows the sidebar
 * (as Ctrl+F11). Sits inside `.game-viewport`.
 */
export function SidebarToggleArrow({ store }: { store: SidebarStore }): JSX.Element {
    const { collapsed } = useSyncExternalStore(
        useCallback((listener: () => void) => store.subscribe(listener), [store]),
        () => store.getState(),
    );
    const zone = useRef<HTMLDivElement>(null);
    const [near, setNear] = useState(false);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent): void => {
            const box = zone.current?.getBoundingClientRect();
            if (!box) return;
            setNear(
                event.clientX <= box.right &&
                    event.clientX >= box.right - NEAR_EDGE &&
                    event.clientY >= box.top &&
                    event.clientY <= box.bottom,
            );
        };
        const onLeave = (): void => setNear(false);
        window.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerleave", onLeave);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerleave", onLeave);
        };
    }, []);

    const label = collapsed ? "Open sidebar" : "Close sidebar";
    return (
        <div ref={zone} className={`rl-sidebar-toggle-zone${near ? " near" : ""}`}>
            <button
                type="button"
                className={`rl-sidebar-toggle${collapsed ? " collapsed" : " close"}`}
                style={{ backgroundImage: `url(${runeliteImage("open_rs.png")})` }}
                onClick={() => store.toggleCollapsed()}
                aria-label={label}
                title={`${label} (Ctrl+F11)`}
            />
        </div>
    );
}
