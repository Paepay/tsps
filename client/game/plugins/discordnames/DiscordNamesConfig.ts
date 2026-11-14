import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** Settings for Discord Names in chat. */
export const DiscordNamesConfig = ConfigGroup("discordnames", {
    brackets: ConfigItem({
        name: "Show brackets",
        description: "Wrap the Discord name in [brackets] before the in-game name.",
        position: 1,
        default: true,
    }),
    colour: ConfigItem<number | undefined>({
        name: "Discord name colour",
        description: "Colour of the Discord name. Leave unset to use the chat line's colour.",
        position: 2,
        color: true,
        default: undefined,
    }),
});
