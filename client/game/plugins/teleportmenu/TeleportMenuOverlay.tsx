import { useSyncExternalStore } from "react";
import type { OsrsClient } from "../../OsrsClient";
import { shortcutLabels } from "./teleportMenuModel";
import type { TeleportMenuPlugin } from "./TeleportMenuPlugin";
import "./TeleportMenuOverlay.css";

/** Parchment-styled, two-stage League teleport menu drawn over the game canvas. */
export function TeleportMenuOverlay({
    osrsClient,
    plugin,
}: {
    osrsClient: OsrsClient;
    plugin: TeleportMenuPlugin;
}): JSX.Element | null {
    const snapshot = useSyncExternalStore(plugin.subscribe, plugin.getSnapshot, plugin.getSnapshot);
    if (!snapshot.screen || osrsClient.isOnLoginScreen()) return null;

    const { screen, selected, message } = snapshot;
    const keys = shortcutLabels(snapshot.handedness);
    return (
        <div className="teleport-menu-backdrop">
            <section
                className="teleport-menu"
                role="dialog"
                aria-modal="true"
                aria-labelledby="teleport-menu-title"
            >
                <header className="teleport-menu-header">
                    <div className="teleport-menu-heading">
                        <div className="teleport-menu-kicker">
                            {screen.stage === "regions" ? "Teleport" : screen.region?.name ?? "Teleport"}
                        </div>
                        <h2 id="teleport-menu-title">{screen.title}</h2>
                    </div>
                    <div className="teleport-menu-header-actions">
                        {screen.canBack && (
                            <button
                                type="button"
                                tabIndex={-1}
                                className="teleport-menu-back"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => plugin.back()}
                            >
                                Back <span className="teleport-menu-inline-key">Backspace</span>
                            </button>
                        )}
                        <button
                            type="button"
                            tabIndex={-1}
                            className="teleport-menu-close"
                            aria-label="Close teleport menu"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => plugin.close()}
                        >
                            ×
                        </button>
                    </div>
                </header>

                <div className="teleport-menu-subhead">
                    <span>{screen.stage === "regions" ? "Choose a region" : "Choose a destination"}</span>
                    <span className="teleport-menu-count">
                        {screen.total} {screen.total === 1 ? "option" : "options"}
                    </span>
                </div>

                <ol
                    className="teleport-menu-list"
                    role="listbox"
                    tabIndex={-1}
                    aria-label={screen.stage === "regions" ? "Regions" : "Destinations"}
                    aria-activedescendant={screen.entries[selected] ? `teleport-menu-option-${screen.entries[selected].index}` : undefined}
                >
                    {screen.entries.map((entry, position) => {
                        const isSelected = position === selected;
                        return (
                            <li key={`${entry.index}:${entry.label}`} className="teleport-menu-item" role="presentation">
                                <button
                                    id={`teleport-menu-option-${entry.index}`}
                                    type="button"
                                    tabIndex={-1}
                                    role="option"
                                    aria-selected={isSelected}
                                    aria-disabled={entry.locked}
                                    aria-describedby={entry.locked && entry.reason ? `teleport-menu-reason-${entry.index}` : undefined}
                                    className={[
                                        "teleport-menu-option",
                                        isSelected ? "is-selected" : "",
                                        entry.locked ? "is-locked" : "",
                                    ].filter(Boolean).join(" ")}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseEnter={() => plugin.setSelected(position)}
                                    onClick={() => plugin.activatePosition(position)}
                                >
                                    <span className="teleport-menu-key" aria-hidden="true">{keys[position]}</span>
                                    <span className="teleport-menu-label">{entry.label}</span>
                                    {entry.locked && <span className="teleport-menu-lock">Locked</span>}
                                </button>
                                {entry.locked && entry.reason && (
                                    <p id={`teleport-menu-reason-${entry.index}`} className="teleport-menu-reason">{entry.reason}</p>
                                )}
                            </li>
                        );
                    })}
                </ol>

                {message && (
                    <div className="teleport-menu-message" role="status" aria-live="polite">
                        {message}
                    </div>
                )}

                <footer className="teleport-menu-footer">
                    <div className="teleport-menu-pager">
                        {screen.pages > 1 && (
                            <>
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    className="teleport-menu-page"
                                    disabled={screen.page === 0}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => plugin.requestPage(screen.page - 1)}
                                >
                                    ← Prev
                                </button>
                                <span className="teleport-menu-page-indicator">
                                    Page {screen.page + 1} of {screen.pages}
                                </span>
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    className="teleport-menu-page"
                                    disabled={screen.page >= screen.pages - 1}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => plugin.requestPage(screen.page + 1)}
                                >
                                    Next →
                                </button>
                            </>
                        )}
                    </div>
                    <div className="teleport-menu-hints">
                        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                        <span><kbd>Enter</kbd> select</span>
                        {screen.canBack && <span><kbd>Backspace</kbd> back</span>}
                        <span><kbd>Esc</kbd> close</span>
                    </div>
                </footer>
            </section>
        </div>
    );
}
