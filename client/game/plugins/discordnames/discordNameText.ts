/** Strip leading chat icon tags (`<img=n>`) from a chat name. */
export function stripChatIcons(name: string): string {
    return String(name ?? "").replace(/^(?:<img=\d+>)+/gi, "");
}

/** Leading icon tags only. */
export function leadingChatIcons(name: string): string {
    return String(name ?? "").match(/^(?:<img=\d+>)*/i)?.[0] ?? "";
}

/** Compare names the way the game does: case-insensitive, `_`/`-`/nbsp as spaces. */
export function normalizePlayerName(name: string): string {
    return stripChatIcons(name)
        .replace(/[\u00a0_-]/g, " ")
        .trim()
        .toLowerCase();
}

/** Discord Blurple-ish default when a colour is configured elsewhere; used only by tests. */
export const DISCORD_BLURPLE = 0x5865f2;

export function wrapWithColorTag(text: string, color: number): string {
    return `<col=${(color & 0xffffff).toString(16).padStart(6, "0")}>${text}</col>`;
}

/**
 * Build the chat name shown when Discord Names is on: icons, then Discord label,
 * then the in-game name. Returns undefined when there is nothing to add.
 */
export function formatDiscordChatName(
    name: string,
    discordName: string | undefined,
    options: { brackets: boolean; colour?: number },
): string | undefined {
    const cleanDiscord = String(discordName ?? "")
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleanDiscord) return undefined;
    const icons = leadingChatIcons(name);
    const bare = stripChatIcons(name);
    if (!bare) return undefined;
    if (normalizePlayerName(bare) === normalizePlayerName(cleanDiscord)) return undefined;
    let label = options.brackets ? `[${cleanDiscord}]` : cleanDiscord;
    if (typeof options.colour === "number") label = wrapWithColorTag(label, options.colour);
    return `${icons}${label} ${bare}`;
}
