/** The browser client's side of the server-authoritative teleport menu. */

export const TELEPORT_MENU_CHANNEL = "teleport-menu";
/** The server sends at most this many entries per screen, one per shortcut. */
export const MENU_SHORTCUT_COUNT = 12;

export const Handedness = {
    RIGHT: "RIGHT",
    LEFT: "LEFT",
} as const;
export type HandednessValue = (typeof Handedness)[keyof typeof Handedness];

/** Physical KeyboardEvent.code values: right-handed `ASDFQWERZXCV`. */
export const RIGHT_HANDED_CODES = [
    "KeyA", "KeyS", "KeyD", "KeyF", "KeyQ", "KeyW", "KeyE", "KeyR", "KeyZ", "KeyX", "KeyC", "KeyV",
] as const;
/** Physical KeyboardEvent.code values: left-handed `;LKJPOIU.M,N`. */
export const LEFT_HANDED_CODES = [
    "Semicolon", "KeyL", "KeyK", "KeyJ", "KeyP", "KeyO", "KeyI", "KeyU", "Period", "KeyM", "Comma", "KeyN",
] as const;
export const RIGHT_HANDED_LABELS = [
    "A", "S", "D", "F", "Q", "W", "E", "R", "Z", "X", "C", "V",
] as const;
export const LEFT_HANDED_LABELS = [
    ";", "L", "K", "J", "P", "O", "I", "U", ".", "M", ",", "N",
] as const;

export type TeleportMenuStage = "regions" | "destinations";

export interface TeleportMenuEntry {
    /** The entry's index in the server's full stage list, not its position on this page. */
    index: number;
    label: string;
    locked: boolean;
    reason?: string;
}

export interface TeleportMenuScreen {
    session: number;
    stage: TeleportMenuStage;
    title: string;
    page: number;
    pages: number;
    total: number;
    canBack: boolean;
    region?: { index: number; name: string };
    entries: TeleportMenuEntry[];
}

export interface TeleportMenuShortcut {
    position: number;
    entry: TeleportMenuEntry;
    code: string;
    label: string;
}

export type TeleportMenuCommand =
    | { type: "close" }
    | { type: "back" }
    | { type: "move"; delta: number }
    | { type: "page"; delta: number }
    | { type: "activate"; position: number }
    | { type: "consume" };

export type TeleportMenuActivation =
    | { kind: "send"; data: { type: "region" | "destination"; session: number; index: number } }
    | { kind: "locked"; message: string };

function normalizeHandedness(handedness: HandednessValue | string | undefined): HandednessValue {
    return handedness === Handedness.LEFT ? Handedness.LEFT : Handedness.RIGHT;
}

export function shortcutCodes(handedness: HandednessValue | string | undefined): readonly string[] {
    return normalizeHandedness(handedness) === Handedness.LEFT ? LEFT_HANDED_CODES : RIGHT_HANDED_CODES;
}

export function shortcutLabels(handedness: HandednessValue | string | undefined): readonly string[] {
    return normalizeHandedness(handedness) === Handedness.LEFT ? LEFT_HANDED_LABELS : RIGHT_HANDED_LABELS;
}

/** The shortcut at a visible position; position 0 reuses the first key on every screen. */
export function shortcutAt(
    handedness: HandednessValue | string | undefined,
    position: number,
): { code: string; label: string } | undefined {
    if (!Number.isInteger(position) || position < 0 || position >= MENU_SHORTCUT_COUNT) return undefined;
    return { code: shortcutCodes(handedness)[position], label: shortcutLabels(handedness)[position] };
}

/** The visible entry a physical key selects, or undefined when the key is not a shortcut here. */
export function shortcutForCode(
    handedness: HandednessValue | string | undefined,
    code: string,
    entries: readonly TeleportMenuEntry[],
): TeleportMenuShortcut | undefined {
    if (!code) return undefined;
    const position = shortcutCodes(handedness).indexOf(code);
    if (position < 0 || position >= entries.length) return undefined;
    return {
        position,
        entry: entries[position],
        code,
        label: shortcutLabels(handedness)[position],
    };
}

/** The action a physical key asks for while the menu is open; the menu owns every other key. */
export function commandForKey(
    handedness: HandednessValue | string | undefined,
    screen: TeleportMenuScreen,
    code: string,
    selected: number,
): TeleportMenuCommand {
    if (code === "Escape") return { type: "close" };
    if (code === "Backspace") return screen.canBack ? { type: "back" } : { type: "consume" };
    if (code === "ArrowUp") return { type: "move", delta: -1 };
    if (code === "ArrowDown") return { type: "move", delta: 1 };
    if (code === "ArrowLeft" || code === "PageUp") return { type: "page", delta: -1 };
    if (code === "ArrowRight" || code === "PageDown") return { type: "page", delta: 1 };
    if (code === "Enter" || code === "NumpadEnter") return { type: "activate", position: selected };
    const shortcut = shortcutForCode(handedness, code, screen.entries);
    return shortcut ? { type: "activate", position: shortcut.position } : { type: "consume" };
}

/** A click, Enter or shortcut on one visible entry: send its action, or explain why it is locked. */
export function activationAt(screen: TeleportMenuScreen, position: number): TeleportMenuActivation | undefined {
    const entry = screen.entries[position];
    if (!entry) return undefined;
    if (entry.locked) return { kind: "locked", message: entry.reason ?? "That teleport is unavailable." };
    return {
        kind: "send",
        data: {
            type: screen.stage === "regions" ? "region" : "destination",
            session: screen.session,
            index: entry.index,
        },
    };
}

/** Arrow-key movement stays within this page's visible entries. */
export function nextSelection(current: number, length: number, delta: number): number {
    if (length <= 0) return 0;
    return Math.max(0, Math.min(length - 1, current + delta));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseEntry(value: unknown): TeleportMenuEntry | undefined {
    if (!isRecord(value)) return undefined;
    const index = integer(value.index);
    if (index === undefined || typeof value.label !== "string") return undefined;
    const locked = value.locked === true;
    const reason = typeof value.reason === "string" && value.reason.length > 0 ? value.reason : undefined;
    return { index, label: value.label, locked, ...(locked && reason ? { reason } : {}) };
}

/** Validates the server's screen packet before the overlay draws it. */
export function parseTeleportMenuScreen(value: unknown): TeleportMenuScreen | undefined {
    if (!isRecord(value) || value.type !== "screen") return undefined;
    const session = integer(value.session);
    const page = integer(value.page);
    const pages = integer(value.pages);
    const total = integer(value.total);
    const stage = value.stage;
    if (
        session === undefined || page === undefined || pages === undefined || total === undefined
        || (stage !== "regions" && stage !== "destinations")
        || typeof value.title !== "string" || typeof value.canBack !== "boolean"
        || !Array.isArray(value.entries)
    ) return undefined;
    const entries: TeleportMenuEntry[] = [];
    for (const raw of value.entries) {
        const entry = parseEntry(raw);
        if (!entry) return undefined;
        entries.push(entry);
    }
    if (entries.length > MENU_SHORTCUT_COUNT || page >= Math.max(1, pages)) return undefined;
    let region: TeleportMenuScreen["region"];
    if (isRecord(value.region)) {
        const index = integer(value.region.index);
        if (index !== undefined && typeof value.region.name === "string") {
            region = { index, name: value.region.name };
        }
    }
    return {
        session,
        stage,
        title: value.title,
        page,
        pages: Math.max(1, pages),
        total,
        canBack: value.canBack,
        ...(region ? { region } : {}),
        entries,
    };
}

/** A DOM element that owns text entry, where menu shortcuts must never fire. */
export function isTextEntryElement(element: Element | null): boolean {
    if (!element) return false;
    const tag = element.tagName.toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
        || (typeof HTMLElement !== "undefined" && element instanceof HTMLElement && element.isContentEditable);
}

/** Chat, a widget text input, or an unrelated DOM field: leave every key to it. */
export function isTypingContext(context: {
    meslayerMode?: number;
    textInputActive?: boolean;
    activeElement?: Element | null;
}): boolean {
    if (context.textInputActive === true) return true;
    if ((context.meslayerMode ?? 0) !== 0) return true;
    return isTextEntryElement(context.activeElement ?? null);
}
