import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";

/** Settings for the Sailing highlights overlay. */
export const SailingConfig = ConfigGroup("sailing", {
    showShipwrecks: ConfigItem({
        name: "Show shipwrecks",
        description: "Highlight raised shipwrecks you can inspect and salvage.",
        position: 0,
        default: true,
    }),
    showSunkenShipwrecks: ConfigItem({
        name: "Show sunken shipwrecks",
        description: "Also outline the sunken wrecks that are not currently raised.",
        position: 1,
        default: false,
    }),
    showChartingMarkers: ConfigItem({
        name: "Show charting markers",
        description: "Highlight spyglasses and current-duck charting hints.",
        position: 2,
        default: true,
    }),
    showChartingRoutes: ConfigItem({
        name: "Show charting routes",
        description: "Draw the current-duck and weather troll routes near you.",
        position: 3,
        default: true,
    }),
    showPortTaskBoards: ConfigItem({
        name: "Show port task boards",
        description: "Highlight port task notice boards near a port.",
        position: 4,
        default: true,
    }),
    shipwreckColor: ConfigItem({
        name: "Shipwreck color",
        description: "Border color of shipwreck clickboxes.",
        position: 5,
        color: true,
        alpha: true,
        default: 0xffffc400,
    }),
    chartingColor: ConfigItem({
        name: "Charting color",
        description: "Border color of charting marker clickboxes.",
        position: 6,
        color: true,
        alpha: true,
        default: 0xff00e5ff,
    }),
    routeColor: ConfigItem({
        name: "Route color",
        description: "Color of the charted route lines.",
        position: 7,
        color: true,
        alpha: true,
        default: 0xff00bfff,
    }),
    boardColor: ConfigItem({
        name: "Port board color",
        description: "Border color of port task boards.",
        position: 8,
        color: true,
        alpha: true,
        default: 0xff66ff66,
    }),
});
