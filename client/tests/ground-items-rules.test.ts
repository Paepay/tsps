import { strict as assert } from "node:assert";
import { ConfigManager, parseConfigValue, serializeConfigValue } from "@runelite/client/config/ConfigManager";
import { Keybind } from "@runelite/client/config/Keybind";
import {
    GROUND_ITEM_TEXT_SIZE_DEFAULT,
    GROUND_ITEM_TEXT_SIZE_MAX,
    GROUND_ITEM_TEXT_SIZE_MIN,
    GroundItemsConfig,
    groundItemTextScale,
} from "../game/plugins/grounditems/GroundItemsConfig";
import {
    EXACT,
    type GroundItem,
    HIDDEN,
    HIGHLIGHTED,
    ItemList,
    NONE,
    type RuleSettings,
    WILDCARD,
    getHighlighted,
    isHidden,
    isHiddenOrHighlighted,
    itemColorOf,
    itemLabel,
    quantityToStackSize,
    shouldDisplayItem,
    tierValue,
} from "../game/plugins/grounditems/groundItemRules";
import { lootbeamSpotAnim } from "../game/plugins/grounditems/lootbeams";
import { migrateGroundItemsConfig } from "../game/plugins/grounditems/migrateGroundItems";
import { isClientSpotAnim, packHsl, registerClientSpotAnim, rgbToHsl, withClientSpotAnims } from "../render/gfx/clientGraphics";

const item = (over: Partial<GroundItem> = {}): GroundItem => ({
    key: "k", id: 1, itemId: 1, name: "Rune scimitar", quantity: 1, haPrice: 0, gePrice: 0,
    tradeable: true, stackable: false, ownership: 0, isPrivate: false, tile: { x: 0, y: 0, level: 0 }, ...over,
});
const settings: RuleSettings = {
    dontHideUntradeables: true,
    hideUnderValue: 0,
    valueCalculationMode: "HIGHEST",
    defaultColor: 0xffffffff,
    highlightedColor: 0xffaa00ff,
    hiddenColor: 0xff808080,
    priceChecks: [
        { price: 10_000_000, color: 4 },
        { price: 1_000_000, color: 3 },
        { price: 100_000, color: 2 },
        { price: 20_000, color: 1 },
    ],
};

// --- ItemList: thresholds, wildcards, quoted exact names; exact beats wildcard ----------------
{
    const list = new ItemList("Rune*, \"Coins\" >100,\nBones<5, dragon bones");
    assert.equal(list.matches("Rune scimitar", 1), WILDCARD);
    assert.equal(list.matches("Coins", 101), EXACT);
    assert.equal(list.matches("Coins", 100), NONE, "strictly more than");
    assert.equal(list.matches("Bones", 4), EXACT);
    assert.equal(list.matches("Bones", 5), NONE);
    assert.equal(list.matches("Dragon  Bones", 1), EXACT, "case and spaces normalised");
    assert.equal(new ItemList("\"rune*\"").matches("Rune scimitar", 1), NONE, "quoted: no wildcard");

    const highlighted = new ItemList("Rune*");
    const hidden = new ItemList("Rune scimitar");
    assert.equal(isHiddenOrHighlighted(item(), highlighted, hidden), HIDDEN, "an exact hide beats a wildcard highlight");
    assert.equal(isHiddenOrHighlighted(item(), new ItemList("Rune scimitar"), new ItemList("Rune*")), HIGHLIGHTED);
    assert.equal(isHiddenOrHighlighted(item(), new ItemList("Rune*"), new ItemList("R*")), HIGHLIGHTED, "both wildcards: highlight");
}

// --- getHighlighted / isHidden / colours -------------------------------------------------------
{
    assert.equal(getHighlighted(item(), HIGHLIGHTED, settings), settings.highlightedColor);
    assert.equal(getHighlighted(item(), HIGHLIGHTED, settings, 0xff123456), 0xff123456, "a per-item colour wins");
    assert.equal(getHighlighted(item({ gePrice: 1_000_000 }), NONE, settings), 2, "a tier needs more than its price");
    assert.equal(getHighlighted(item({ gePrice: 1_000_001 }), NONE, settings), 3);
    assert.equal(getHighlighted(item({ gePrice: 1_000_001 }), HIDDEN, settings), undefined, "explicitly hidden: no tier");
    assert.equal(getHighlighted(item({ haPrice: 50_000 }), NONE, { ...settings, valueCalculationMode: "GE" }), undefined);
    assert.equal(getHighlighted(item({ gePrice: 7_000, quantity: 3 }), NONE, settings), 1, "stack value");

    const s = { ...settings, hideUnderValue: 100 };
    assert.equal(isHidden(item({ gePrice: 50, haPrice: 30 }), NONE, s), true, "under both prices");
    assert.equal(isHidden(item({ gePrice: 150, haPrice: 30 }), NONE, s), false);
    assert.equal(isHidden(item({ tradeable: false }), NONE, s), false, "untradeables not hidden by value");
    assert.equal(isHidden(item({ tradeable: false }), NONE, { ...s, dontHideUntradeables: false }), true);
    assert.equal(isHidden(item(), HIGHLIGHTED, s), false);
    assert.equal(isHidden(item({ gePrice: 9e9 }), HIDDEN, s), true);
    assert.equal(itemColorOf(undefined, true, settings), settings.hiddenColor);
    assert.equal(itemColorOf(undefined, false, settings), settings.defaultColor);
    assert.equal(tierValue("HIGH", { low: 1, medium: 2, high: 3, insane: 4 }), 3);
    assert.equal(tierValue("OFF", { low: 1, medium: 2, high: 3, insane: 4 }), undefined);
}

// --- Labels: QuantityFormatter and price display modes -----------------------------------------
{
    assert.deepEqual(
        [999, 9_999, 10_000, 15_500, 123_456, 1_500_000, 1_234_567_890].map(quantityToStackSize),
        ["999", "9,999", "10K", "15.5K", "123K", "1.5M", "1.23B"],
    );
    const it = item({ quantity: 2, gePrice: 30_000, haPrice: 20_000 });
    assert.equal(itemLabel(it, "BOTH"), "Rune scimitar (2) (GE: 60K gp) (HA: 40K gp)");
    assert.equal(itemLabel(it, "GE"), "Rune scimitar (2) (60K gp)");
    assert.equal(itemLabel(it, "HA"), "Rune scimitar (2) (40K gp)");
    assert.equal(itemLabel(it, "OFF"), "Rune scimitar (2)");
    assert.equal(itemLabel(item({ id: 995, name: "Coins", quantity: 500, gePrice: 1, haPrice: 1 }), "BOTH"), "Coins (500)", "no price on coins");
    assert.equal(itemLabel(item({ gePrice: 0, haPrice: 0 }), "BOTH"), "Rune scimitar", "no zero prices");
}

// --- Ownership filter ----------------------------------------------------------------------------
assert.equal(shouldDisplayItem("DROPS", 1, 0), true);
assert.equal(shouldDisplayItem("DROPS", 2, 0), false);
assert.equal(shouldDisplayItem("TAKEABLE", 2, 0), true, "mains can take others' items once public");
assert.equal(shouldDisplayItem("TAKEABLE", 2, 1), false);
assert.equal(shouldDisplayItem("ALL", 2, 1), true);

// --- Settings: RuneLite's keys and defaults; the keybind setting --------------------------------
{
    const items = GroundItemsConfig.items as any;
    assert.equal(GroundItemsConfig.group, "grounditems");
    assert.equal(items.valueCalculationMode.keyName, "highlightValueCalculation");
    assert.equal(items.hiddenItems.default, "Vial, Ashes, Coins, Bones, Bucket, Jug, Seaweed");
    assert.equal(items.itemHighlightMode.default, "BOTH");
    assert.equal(items.menuHighlightMode.default, "NAME");
    assert.equal(items.showLootbeamTier.default, "HIGH");
    assert.equal(items.highlightedColor.default, 0xffaa00ff);
    assert.ok(items.hotkey.default.equals(Keybind.ALT));
    assert.equal(items.textSize.default, GROUND_ITEM_TEXT_SIZE_DEFAULT);
    assert.deepEqual(items.textSize.range, { min: GROUND_ITEM_TEXT_SIZE_MIN, max: GROUND_ITEM_TEXT_SIZE_MAX });
    assert.equal(groundItemTextScale(125), 1.25);
    assert.equal(groundItemTextScale(1), GROUND_ITEM_TEXT_SIZE_MIN / 100, "below the range: clamped");
    assert.equal(groundItemTextScale(999), GROUND_ITEM_TEXT_SIZE_MAX / 100, "above the range: clamped");
    assert.equal(groundItemTextScale(Number.NaN), 1, "unreadable: the default");

    assert.equal(serializeConfigValue(items.hotkey, Keybind.ALT), "0:512");
    assert.ok((parseConfigValue(items.hotkey, "88:128") as Keybind).equals(new Keybind(88, 128)));
    assert.ok((parseConfigValue(items.hotkey, "junk") as Keybind).equals(Keybind.ALT), "bad value: default");
    assert.ok(new Keybind(18, 0).equals(Keybind.ALT), "a lone modifier key is stored as its modifier");
    assert.ok(Keybind.ALT.matches({ keyCode: 18, altKey: true }), "pressing Alt");
    assert.ok(!Keybind.ALT.matches({ keyCode: 65, altKey: true }), "Alt+A is another keybind");
    assert.ok(Keybind.ALT.releasedBy({ keyCode: 18 }));
    assert.ok(new Keybind(88, 128).matches({ keyCode: 88, ctrlKey: true }));
    assert.equal(new Keybind(88, 128).describe(), "Ctrl+X");
    assert.ok(!Keybind.NOT_SET.matches({ keyCode: 0 }));
    assert.equal(parseConfigValue(items.hiddenItems, ""), "", "a cleared list stays cleared");
    assert.equal(parseConfigValue(items.priceDisplayMode, ""), "BOTH", "an empty enum: default");
    assert.equal(parseConfigValue(items.hideUnderValue, ""), 0);
}

// --- Migration of the earlier keys and values -------------------------------------------------
{
    const cm = new ConfigManager(undefined);
    cm.setConfiguration("grounditems", "rightClickHidden", "true");
    cm.setConfiguration("grounditems", "valueCalculationMode", "ge");
    cm.setConfiguration("grounditems", "despawnTimerMode", "ticks");
    cm.setConfiguration("grounditems", "priceDisplayMode", "Both");
    cm.setConfiguration("grounditems", "highlightedColor", "#123456");
    migrateGroundItemsConfig(cm);
    assert.equal(cm.getConfiguration("grounditems", "deprioritizeHiddenItems"), "true");
    assert.equal(cm.getConfiguration("grounditems", "rightClickHidden"), undefined);
    assert.equal(cm.getConfiguration("grounditems", "highlightValueCalculation"), "GE");
    assert.equal(cm.getConfiguration("grounditems", "groundItemTimers"), "TICKS");
    assert.equal(cm.getConfiguration("grounditems", "priceDisplayMode"), "BOTH");
    assert.equal(cm.getConfiguration("grounditems", "highlightedColor"), "#ff123456");
    cm.setConfiguration("grounditems", "priceDisplayMode", "both");
    migrateGroundItemsConfig(cm);
    assert.equal(cm.getConfiguration("grounditems", "priceDisplayMode"), "both", "runs once");
}

// --- Client graphics and loot beam colours ------------------------------------------------------
{
    assert.equal(packHsl(63, 7, 127), 0xffff);
    assert.equal(rgbToHsl(0xffffff), packHsl(0, 0, 127));
    const red = rgbToHsl(0xff0000);
    assert.equal(red >> 10, 0, "red: hue 0");
    assert.equal((red >> 7) & 7, 7, "red: full saturation");

    const modern = lootbeamSpotAnim("MODERN", 0xffff9600);
    assert.equal(modern.modelId, 43330);
    assert.equal(modern.sequenceId, 9260);
    assert.deepEqual(modern.recolorFrom, [26432, 26584]);
    const hsl = rgbToHsl(0xff9600);
    const [h, s, l] = [(hsl >> 10) & 63, (hsl >> 7) & 7, hsl & 127];
    assert.deepEqual(modern.recolorTo, [packHsl(h, s > 2 ? s - 1 : s, l), packHsl(h, s, Math.min(l + 24, 127))]);
    assert.deepEqual([modern.ambient! + 64, modern.contrast! + 850], [139, 2643], "RuneLite's lighting");
    const light = lootbeamSpotAnim("LIGHT", 0xffff9600);
    assert.deepEqual([light.modelId, light.sequenceId, light.recolorFrom, light.recolorTo], [5809, 3101, [6371], [hsl]]);

    const id = registerClientSpotAnim(modern);
    assert.equal(registerClientSpotAnim({ ...modern }), id, "one id per definition");
    assert.ok(isClientSpotAnim(id) && id >= 1_000_000);
    const loader = withClientSpotAnims({ load: (n: number) => ({ cache: n }) as any, getCount: () => 5, clearCache: () => {} });
    assert.equal((loader.load(id) as any).modelId, 43330);
    assert.deepEqual(loader.load(3), { cache: 3 });
}

console.log("ground items rules tests passed");
