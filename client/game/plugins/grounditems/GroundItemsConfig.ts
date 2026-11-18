import { ConfigGroup, ConfigItem } from "@runelite/client/config/ConfigItem";
import { Keybind } from "@runelite/client/config/Keybind";

export type PriceDisplayMode = "HA" | "GE" | "BOTH" | "OFF";
export type ItemHighlightMode = "NONE" | "OVERLAY" | "MENU" | "BOTH";
export type MenuHighlightMode = "OPTION" | "NAME" | "BOTH";
export type ValueCalculationMode = "HA" | "GE" | "HIGHEST";
export type OwnershipFilterMode = "ALL" | "TAKEABLE" | "DROPS";
export type DespawnTimerMode = "OFF" | "PIE" | "TICKS" | "SECONDS";
export type HighlightTier = "OFF" | "LOW" | "MEDIUM" | "HIGH" | "INSANE";
export type LootbeamStyle = "LIGHT" | "MODERN";

export const GROUND_ITEM_TEXT_SIZE_MIN = 50;
export const GROUND_ITEM_TEXT_SIZE_MAX = 200;
export const GROUND_ITEM_TEXT_SIZE_DEFAULT = 100;

/** The ground-item label font scale, as a fraction of the dynamic overlay font's size. */
export function groundItemTextScale(size: number): number {
    const percent = Number.isFinite(size) ? Math.round(size) : GROUND_ITEM_TEXT_SIZE_DEFAULT;
    return Math.max(GROUND_ITEM_TEXT_SIZE_MIN, Math.min(GROUND_ITEM_TEXT_SIZE_MAX, percent)) / 100;
}

const names = <T extends string>(...values: T[]) => Object.fromEntries(values.map((v) => [v, v])) as Record<T, T>;
const TIERS = names<HighlightTier>("OFF", "LOW", "MEDIUM", "HIGH", "INSANE");
const opaque = (rgb: number) => (0xff000000 | rgb) >>> 0;

/**
 * RuneLite 1.13.3 GroundItemsConfig: group, keys, names, descriptions, positions, defaults and
 * enum names as in RuneLite (enum labels are its toString). The two items at position 5 are
 * declared in name order, as RuneLite lists equal positions.
 */
export const GroundItemsConfig = ConfigGroup(
    "grounditems",
    {
        highlightedItems: ConfigItem({
            name: "Highlighted items",
            description: "Configures specifically highlighted ground items. Format: item1, item2, item3",
            section: "itemLists",
            position: 0,
            textArea: true,
            default: "",
        }),
        hiddenItems: ConfigItem({
            name: "Hidden items",
            description: "Configures hidden ground items. Format: item1, item2, item3",
            section: "itemLists",
            position: 1,
            textArea: true,
            default: "Vial, Ashes, Coins, Bones, Bucket, Jug, Seaweed",
        }),
        showHighlightedOnly: ConfigItem({
            name: "Show highlighted items only",
            description: "Configures whether or not to draw items only on your highlighted list.",
            position: 2,
            default: false,
        }),
        dontHideUntradeables: ConfigItem({
            name: "Do not hide untradeables",
            description: "Configures whether or not untradeable items ignore hiding under settings.",
            position: 3,
            default: true,
        }),
        showMenuItemQuantities: ConfigItem({
            name: "Show menu item quantities",
            description: "Configures whether or not to show the item quantities in the menu.",
            position: 4,
            default: true,
        }),
        deprioritizeHiddenItems: ConfigItem({
            name: "Deprioritize menu hidden items",
            description: "Depriotizies the menu options for items which are hidden, requiring a right-click to pick up.",
            position: 5,
            default: false,
        }),
        recolorMenuHiddenItems: ConfigItem({
            name: "Recolor menu hidden items",
            description: "Configures whether or not hidden items in right-click menu will be recolored.",
            position: 5,
            default: false,
        }),
        highlightTiles: ConfigItem({
            name: "Highlight tiles",
            description: "Configures whether or not to highlight tiles containing ground items.",
            position: 6,
            default: false,
        }),
        notifyHighlightedDrops: ConfigItem({
            name: "Notify for highlighted drops",
            description: "Configures whether or not to notify for drops on your highlighted list.",
            position: 7,
            default: false,
        }),
        notifyTier: ConfigItem<HighlightTier>({
            name: "Notify tier",
            description: "Configures which price tiers will trigger a notification on drop.",
            position: 8,
            enum: TIERS,
            default: "OFF",
        }),
        priceDisplayMode: ConfigItem<PriceDisplayMode>({
            name: "Price display mode",
            description: "Configures which price types are shown alongside ground item name.",
            position: 9,
            enum: names<PriceDisplayMode>("HA", "GE", "BOTH", "OFF"),
            enumLabels: { HA: "High Alchemy", GE: "Grand Exchange", BOTH: "Both", OFF: "Off" },
            default: "BOTH",
        }),
        itemHighlightMode: ConfigItem<ItemHighlightMode>({
            name: "Item highlight mode",
            description: "Configures how ground items will be highlighted.",
            position: 10,
            enum: names<ItemHighlightMode>("NONE", "OVERLAY", "MENU", "BOTH"),
            enumLabels: { NONE: "None", OVERLAY: "Overlay", MENU: "Right-click menu", BOTH: "Both" },
            default: "BOTH",
        }),
        menuHighlightMode: ConfigItem<MenuHighlightMode>({
            name: "Menu highlight mode",
            description: "Configures what to highlight in right-click menu.",
            position: 11,
            enum: names<MenuHighlightMode>("OPTION", "NAME", "BOTH"),
            enumLabels: { OPTION: "Menu option", NAME: "Menu item name", BOTH: "Both" },
            default: "NAME",
        }),
        valueCalculationMode: ConfigItem<ValueCalculationMode>({
            keyName: "highlightValueCalculation",
            name: "Highlight value calculation",
            description: "Configures which coin value is used to determine highlight color.",
            position: 12,
            enum: names<ValueCalculationMode>("HA", "GE", "HIGHEST"),
            enumLabels: { HA: "High Alchemy", GE: "Grand Exchange", HIGHEST: "Highest" },
            default: "HIGHEST",
        }),
        hideUnderValue: ConfigItem({
            name: "Hide under value",
            description: "Configures hidden ground items under both GE and HA value.",
            position: 13,
            default: 0,
        }),
        defaultColor: ConfigItem({
            name: "Default items",
            description: "Configures the color for default, non-highlighted items.",
            position: 14,
            color: true,
            alpha: true,
            default: opaque(0xffffff),
        }),
        highlightedColor: ConfigItem({
            name: "Highlighted items",
            description: "Configures the color for highlighted items.",
            position: 15,
            color: true,
            alpha: true,
            default: opaque(0xaa00ff),
        }),
        hiddenColor: ConfigItem({
            name: "Hidden items",
            description: "Configures the color for hidden items in right-click menu and when holding ALT.",
            position: 16,
            color: true,
            alpha: true,
            default: opaque(0x808080),
        }),
        lowValueColor: ConfigItem({
            name: "Low value items",
            description: "Configures the color for low value items.",
            position: 17,
            color: true,
            alpha: true,
            default: opaque(0x66b2ff),
        }),
        lowValuePrice: ConfigItem({
            name: "Low value price",
            description: "Configures the start price for low value items.",
            position: 18,
            default: 20_000,
        }),
        mediumValueColor: ConfigItem({
            name: "Medium value items",
            description: "Configures the color for medium value items.",
            position: 19,
            color: true,
            alpha: true,
            default: opaque(0x99ff99),
        }),
        mediumValuePrice: ConfigItem({
            name: "Medium value price",
            description: "Configures the start price for medium value items.",
            position: 20,
            default: 100_000,
        }),
        highValueColor: ConfigItem({
            name: "High value items",
            description: "Configures the color for high value items.",
            position: 21,
            color: true,
            alpha: true,
            default: opaque(0xff9600),
        }),
        highValuePrice: ConfigItem({
            name: "High value price",
            description: "Configures the start price for high value items.",
            position: 22,
            default: 1_000_000,
        }),
        insaneValueColor: ConfigItem({
            name: "Insane value items",
            description: "Configures the color for insane value items.",
            position: 23,
            color: true,
            alpha: true,
            default: opaque(0xff66b2),
        }),
        insaneValuePrice: ConfigItem({
            name: "Insane value price",
            description: "Configures the start price for insane value items.",
            position: 24,
            default: 10_000_000,
        }),
        ownershipFilterMode: ConfigItem<OwnershipFilterMode>({
            name: "Ownership filter",
            description: "Show all items, takeable items, or only your or your group's drops.",
            position: 25,
            enum: names<OwnershipFilterMode>("ALL", "TAKEABLE", "DROPS"),
            enumLabels: { ALL: "All", TAKEABLE: "Takeable", DROPS: "Drops" },
            default: "ALL",
        }),
        doubleTapDelay: ConfigItem({
            name: "Double-tap delay",
            description: "Delay for the double-tap ALT to hide ground items. 0 to disable.",
            position: 26,
            units: "ms",
            default: 250,
        }),
        collapseEntries: ConfigItem({
            name: "Collapse ground item menu",
            description: "Collapses ground item menu entries together and appends count.",
            position: 27,
            default: false,
        }),
        groundItemTimers: ConfigItem<DespawnTimerMode>({
            name: "Despawn timer",
            description: "Shows despawn timers for items you've dropped and received as loot.",
            position: 28,
            enum: names<DespawnTimerMode>("OFF", "PIE", "TICKS", "SECONDS"),
            default: "OFF",
        }),
        textOutline: ConfigItem({
            name: "Text outline",
            description: "Use an outline around text instead of a text shadow.",
            position: 29,
            default: false,
        }),
        showLootbeamForHighlighted: ConfigItem({
            name: "Highlighted item lootbeams",
            description: "Configures lootbeams to show for all highlighted items.",
            position: 30,
            default: false,
        }),
        showLootbeamTier: ConfigItem<HighlightTier>({
            name: "Lootbeam tier",
            description: "Configures which price tiers will trigger a lootbeam.",
            position: 31,
            enum: TIERS,
            default: "HIGH",
        }),
        lootbeamStyle: ConfigItem<LootbeamStyle>({
            name: "Lootbeam style",
            description: "Style of lootbeam to use.",
            position: 32,
            enum: names<LootbeamStyle>("LIGHT", "MODERN"),
            default: "MODERN",
        }),
        hotkey: ConfigItem<Keybind>({
            name: "Hotkey",
            description: "Configures the hotkey used by the Ground Items plugin.",
            position: 33,
            keybind: true,
            default: Keybind.ALT,
        }),
        textSize: ConfigItem({
            name: "Label text size",
            description: "Scales ground item labels relative to the Dynamic overlay font size.",
            position: 34,
            units: "%",
            range: { min: GROUND_ITEM_TEXT_SIZE_MIN, max: GROUND_ITEM_TEXT_SIZE_MAX },
            step: 1,
            default: GROUND_ITEM_TEXT_SIZE_DEFAULT,
        }),
    },
    {
        sections: {
            itemLists: { name: "Item lists", position: 0 },
        },
    },
);
