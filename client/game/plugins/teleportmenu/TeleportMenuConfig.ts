import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";
import { Handedness, type HandednessValue } from "./teleportMenuModel";

export const TeleportMenuConfig = ConfigGroup("teleportmenu", {
    handedness: ConfigItem<HandednessValue>({
        name: "Handedness",
        description: "Chooses the keyboard shortcut layout: ASDFQWERZXCV for a right-handed mouse, ;LKJPOIU.M,N for a left-handed one.",
        position: 0,
        enum: {
            "Right-handed": Handedness.RIGHT,
            "Left-handed": Handedness.LEFT,
        },
        default: Handedness.RIGHT,
    }),
});
