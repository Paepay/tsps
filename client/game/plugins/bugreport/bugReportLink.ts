/**
 * Pure helpers for the GitHub-issue-link bug report flow.
 *
 * No token anywhere: the player files the issue themselves from the prefilled
 * `issues/new` page, so every report is tied to a real GitHub account and GitHub's
 * own spam protection applies. Everything here is unit-testable without a client.
 */

/** Where the player's browser opens a prefilled issue. */
export const BUG_REPORT_ISSUE_URL = "https://github.com/Paepay/tsps/issues/new";

/** The issue form the button fills; its field ids are `description` and `diagnostics`. */
export const BUG_REPORT_TEMPLATE = "bug_report.yml";

/**
 * GitHub and browsers stop handling very long `issues/new` URLs (around 8 KB), so the
 * whole URL is capped. The body shrinks to fit; nothing else grows to fill it.
 */
export const MAX_ISSUE_URL_LENGTH = 8000;

/** An IPv4 literal: client, relay and server addresses must never reach a public issue. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/**
 * A real IPv6 literal: the full eight-group form, or anything with `::`. Narrower
 * colon shapes (`12:30:45`, `Foo.ts:123:45`) are timestamps and stack frames, whose
 * line numbers the report needs, so they are left alone.
 */
const IPV6 =
    /(?<![0-9a-fA-F:.])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:.])|(?<![0-9a-fA-F:.])[0-9a-fA-F:.]*::[0-9a-fA-F:.]*(?![0-9a-fA-F:.])/g;

/** Address literals left out, keeping the line that carried them. */
export function redactAddresses(text: string): string {
    return text.replace(IPV4, "(address left out)").replace(IPV6, "(address left out)");
}

/** Cut to whole code points, so an emoji at the boundary never loses half of itself. */
export function truncateCodePoints(text: string, maxCodePoints: number): string {
    const points = Array.from(text);
    return points.length <= maxCodePoints ? text : points.slice(0, maxCodePoints).join("");
}

/** Coarse browser family from the UA: enough for "only repros on Safari", nothing fingerprintable. */
export function coarseBrowser(userAgent: string): string {
    const ua = userAgent.toLowerCase();
    if (ua.includes("edg/") || ua.includes("edge/")) return "Edge";
    if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
    if (ua.includes("chrome/") && !ua.includes("chromium")) return "Chrome";
    if (ua.includes("firefox/") || ua.includes("fxios/")) return "Firefox";
    if (ua.includes("safari/")) return "Safari";
    return "Other";
}

function codePoints(text: string): number {
    return Array.from(text).length;
}

/**
 * Which frame a Copy click puts on the clipboard.
 *
 * A click captures again (`fresh`). When that capture yields no frame, the frame from before
 * the click may stand in — but only while the session it belongs to still exists: a logout or
 * a newer capture moves the capture generation on, and that frame then belongs to a session
 * that no longer exists.
 */
export function resolveCopyFrame<T>(frame: {
    fresh: T | undefined;
    previous: T | undefined;
    expectedGeneration: number;
    generation: number;
    loggedIn: boolean;
}): T | undefined {
    if (frame.fresh !== undefined) return frame.fresh;
    const sameSession = frame.loggedIn && frame.generation === frame.expectedGeneration;
    return sameSession ? frame.previous : undefined;
}

/** What the panel says after the issue tab is opened. */
export const ISSUE_TAB_NOTICE = "The issue page should be open in a new tab. Paste the screenshot in with Ctrl+V.";

/**
 * Opens the issue tab and returns the notice to show.
 *
 * `window.open` with `noopener` returns `null` even when the tab really opens (Chrome keeps
 * the handle hidden from the opener), so its return value cannot tell a success from a
 * blocked popup. Reporting "popup blocked" on a `null` return claimed failure on every
 * successful click, so the notice is the same either way and the player is never told to
 * retry a tab that is already there.
 */
export function openIssueTab(url: string, open: (url: string) => unknown): string {
    open(url);
    return ISSUE_TAB_NOTICE;
}

/**
 * The prefilled issue link: `template` selects the issue form, then `title`, `description`
 * and `diagnostics` fill its fields by id. The markdown `body` parameter does not apply to
 * issue forms, so the report is split across the form's own fields instead of one body.
 */
export function buildIssueUrl(title: string, description: string, diagnostics: string): string {
    const safeTitle = truncateCodePoints(title.trim(), 80);
    const base =
        `${BUG_REPORT_ISSUE_URL}?template=${BUG_REPORT_TEMPLATE}` +
        `&title=${encodeURIComponent(safeTitle)}`;
    let safeDesc = description.trim();
    let safeDiag = diagnostics;
    const url = () =>
        `${base}&description=${encodeURIComponent(safeDesc)}&diagnostics=${encodeURIComponent(safeDiag)}`;
    let built = url();
    while (built.length > MAX_ISSUE_URL_LENGTH) {
        // Diagnostics shrink first; the player's own words are only cut when nothing else is left.
        const target = codePoints(safeDiag) > 0 ? "diag" : codePoints(safeDesc) > 0 ? "desc" : undefined;
        if (!target) break;
        const overshoot = Math.max(1, Math.ceil((built.length - MAX_ISSUE_URL_LENGTH) / 3));
        if (target === "diag") {
            safeDiag = truncateCodePoints(safeDiag, Math.max(0, codePoints(safeDiag) - overshoot));
        } else {
            safeDesc = truncateCodePoints(safeDesc, Math.max(0, codePoints(safeDesc) - overshoot));
        }
        built = url();
    }
    return built;
}

/** One error section for the issue body: last warn/error lines, redacted and shortened. */
export function formatErrorLines(lines: readonly string[], maxLines = 10, maxChars = 300): string {
    return lines
        .slice(-maxLines)
        .map((line) => truncateCodePoints(redactAddresses(line), maxChars))
        .join("\n");
}

export type BugReportPosition = { x: number; y: number; plane: number };

/**
 * Who the report may name. Login state wins over whatever the client still holds:
 * after a logout `localPlayerName` keeps the previous account, so a logged-out
 * report must never emit it (or its position) in the `Player:` line.
 */
export function resolvePlayer(
    loggedIn: boolean,
    rawName: string | undefined,
    position: BugReportPosition | undefined,
): { name: string; position: BugReportPosition | undefined } {
    if (!loggedIn) return { name: "(logged out)", position: undefined };
    const name = rawName?.trim() ? rawName : "(unknown)";
    return { name, position };
}

/** The diagnostics allowlist, as plain data: no user agent, language, timezone, page URL,
 * world address, inventory, skills, varps, interfaces or full console. Account state
 * (name, position) is in; anything identifying a real person is out. */
export type BugReportDiagnostics = {
    loggedIn: boolean;
    player: string;
    position?: BugReportPosition;
    world: string;
    worldId?: string;
    members: boolean;
    tick: number;
    transport: string;
    renderer: string;
    viewport: string;
    fps: number;
    mobile: boolean;
    cache?: string;
    failedPlugins: Record<string, string>;
    errors: string;
    skills?: string;
    inventory?: string;
    equipment?: string;
    varps?: string;
    interfaces?: string;
    messages: string[];
};

/**
 * The diagnostics field of the prefilled form: world, player, client, errors, then the
 * bulky account sections. Caps are per section; when the URL still overflows, the
 * shrink in `buildIssueUrl` cuts from the end, so game messages go before errors.
 * A failed read prints `(unavailable)`; only a successful empty read prints `(empty)`.
 */
export function formatDiagnosticsSection(diagnostics: BugReportDiagnostics): string {
    const browser = typeof navigator === "undefined" ? "unknown" : coarseBrowser(navigator.userAgent);
    const capped = (text: string | undefined, max: number, empty = "(empty)"): string =>
        text === undefined ? "(unavailable)" : truncateCodePoints(redactAddresses(text), max) || empty;
    const worldLine =
        `World: ${diagnostics.world}${diagnostics.worldId ? ` (${diagnostics.worldId})` : ""}` +
        `, tick ${diagnostics.tick}, ${diagnostics.transport}, ${diagnostics.members ? "members" : "free"}`;
    const region =
        diagnostics.position !== undefined
            ? `, region ${((diagnostics.position.x >> 6) << 8) | (diagnostics.position.y >> 6)}`
            : "";
    const lines = [
        "---",
        worldLine,
        `Player: ${diagnostics.player}${
            diagnostics.position
                ? ` at ${diagnostics.position.x}, ${diagnostics.position.y}, ${diagnostics.position.plane}${region}`
                : ""
        }`,
        `Client: ${browser}, ${diagnostics.renderer}, ${diagnostics.viewport}, ${diagnostics.fps} fps${diagnostics.mobile ? ", mobile" : ""}${diagnostics.cache ? `, cache ${diagnostics.cache}` : ""}`,
    ];
    const failed = Object.entries(diagnostics.failedPlugins);
    if (failed.length > 0) {
        lines.push(`Failed plugins: ${failed.map(([name]) => name).join(", ")}`);
    }
    lines.push("", "Recent errors:", "```", diagnostics.errors, "```");
    // Account state is only meaningful logged in. A failed read already prints
    // `(unavailable)` through `capped`, so every section renders either way.
    if (!diagnostics.loggedIn) {
        lines.push("", "(Logged out: log in to include account state.)");
    } else {
        const skills = capped(diagnostics.skills, 300);
        lines.push("", `Skills: ${skills}`);
        lines.push(`Inventory: ${capped(diagnostics.inventory, 400)}`);
        lines.push(`Equipment: ${capped(diagnostics.equipment, 300)}`);
        lines.push(`Varps: ${capped(diagnostics.varps, 300)}`);
        lines.push(`Interfaces: ${capped(diagnostics.interfaces, 150)}`);
    }
    const messages = diagnostics.messages
        .slice(-8)
        .map((message) => truncateCodePoints(redactAddresses(message), 120))
        .filter((message) => message.trim().length > 0);
    if (messages.length > 0) lines.push("", "Game messages:", "```", messages.join("\n"), "```");
    return lines.join("\n");
}
