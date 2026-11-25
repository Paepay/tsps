import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** Settings for the rooftop agility obstacle clickboxes. */
export const RooftopAgilityConfig = ConfigGroup("rooftopagility", {
    showClickboxes: ConfigItem({
        name: "Show clickboxes",
        description: "Draw a clickbox around every obstacle of the rooftop agility courses.",
        position: 0,
        default: true,
    }),
    clickboxColor: ConfigItem({
        name: "Clickbox color",
        description: "Border color of the rooftop obstacle clickboxes.",
        position: 1,
        color: true,
        alpha: true,
        default: 0xff00e5ff,
    }),
    fillColor: ConfigItem({
        name: "Clickbox fill color",
        description: "Fill color inside the rooftop obstacle clickboxes.",
        position: 2,
        color: true,
        alpha: true,
        default: 0x4000e5ff,
    }),
    borderWidth: ConfigItem({
        name: "Border width",
        description: "Width of the clickbox border in pixels.",
        position: 3,
        step: 0.1,
        range: { min: 0, max: 10 },
        default: 2,
    }),
});
