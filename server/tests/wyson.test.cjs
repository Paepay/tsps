// node --test tests/wyson.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Wyson = require('../plugins/npcs/Wyson.plugin');
const dialogues = require('../data/definitions/npc-dialogues.json');

const COINS = 995, WOAD_LEAF = 1793, WYSON = 5422;
const MOLE_CLAW = 7416, MOLE_SKIN = 7418, IMMACULATE_MOLE_SKIN = 33382;
const NOTED_MOLE_CLAW = 7417, NOTED_MOLE_SKIN = 7419, NOTED_IMMACULATE_MOLE_SKIN = 33383;
const SEED_NEST = 22800, RING_NEST = 5074, EMPTY_NEST = 5075;
const SEED_BOX = 23062, RING_BOX = 12794, EMPTY_BOX = 12792;
const BOX_META = 'wyson:nest-box';
class Item {
    constructor(id, amount = 1) { this.id = id; this.amount = amount; this.meta = null; }
    getId() { return this.id; }
    getAmount() { return this.amount; }
    setMetaValue(key, value) {
        this.meta ??= {};
        if (value === undefined) delete this.meta[key]; else this.meta[key] = value;
        return this;
    }
    getMetaValue(key) { return this.meta?.[key]; }
}
let condition, variant;
let membersWorld = true;
const actions = [];
const action = (event) => { for (const handler of actions) handler(event); };
Wyson.register({
    core: {
        Item,
        WorldDefinition: { isMembersWorld: () => membersWorld },
        NpcIdentifiers: { WYSON_THE_GARDENER: WYSON },
        ItemIdentifiers: { COINS, WOAD_LEAF, MOLE_CLAW, MOLE_CLAW_2: NOTED_MOLE_CLAW,
            MOLE_SKIN, MOLE_SKIN_2: NOTED_MOLE_SKIN, IMMACULATE_MOLE_SKIN,
            IMMACULATE_MOLE_SKIN_2: NOTED_IMMACULATE_MOLE_SKIN,
            NEST_BOX_SEEDS__4: SEED_BOX, NEST_BOX_RING_: RING_BOX, NEST_BOX_EMPTY_: EMPTY_BOX,
            BIRD_NEST_12: SEED_NEST, BIRD_NEST_5: RING_NEST, BIRD_NEST_6: EMPTY_NEST },
    },
    onNpcDialogueVariant: (handler) => { variant = handler; },
    onNpcDialogueCondition: (handler) => { condition = handler; },
    onCustomEvent: (name, handler) => { assert.equal(name, 'npc-dialogue:action'); actions.push(handler); },
});

/** A 28-slot inventory; each entry is null, an id (amount 1) or { id, amount }. */
function slotted(entries) {
    const items = Array.from({ length: 28 }, (_, slot) => {
        const entry = entries[slot];
        if (!entry) return null;
        return typeof entry === 'number' ? new Item(entry) : new Item(entry.id, entry.amount ?? 1);
    });
    const p = {
        messages: [],
        items,
        refreshed: 0,
        sendMessage(m) { this.messages.push(m); },
        ids: () => items.map((item) => item?.getId() ?? null),
        getInventory: () => ({
            getItems: () => items,
            getFreeSlots: () => items.filter((item) => !item).length,
            getAmount: (id) => items.reduce((n, item) => n + (item?.getId() === id ? item.getAmount() : 0), 0),
            deleteAtSlot: (slot, amount = 1) => {
                const item = items[slot];
                if (!item) return;
                if (item.getAmount() <= amount) items[slot] = null; else item.amount -= amount;
            },
            add: (item) => { const slot = items.findIndex((each) => !each); if (slot >= 0) items[slot] = item; },
            refreshItems: () => { p.refreshed++; },
        }),
    };
    return p;
}

function player(coins, room = true) {
    const items = new Map([[COINS, coins]]);
    return {
        messages: [],
        items,
        sendMessage(m) { this.messages.push(m); },
        getInventory: () => ({
            getAmount: (id) => items.get(id) ?? 0,
            deleteNumber: (id, n) => items.set(id, (items.get(id) ?? 0) - n),
            adds: (id, n) => { if (room || id === COINS) items.set(id, (items.get(id) ?? 0) + n); },
        }),
    };
}
const pages = [{ page: 'Wyson the gardener' }];

test('the plugin answers the transcript\'s own condition texts and action ids', () => {
    const text = JSON.stringify(dialogues['Wyson the gardener']);
    for (const t of ["If the player has at least 15 coins:", "If the player doesn't have 15 coins:",
        "If the player has at least 20 coins:", "If the player doesn't have 20 coins:", '"bywQsQ"', '"F6m-S9"']) {
        assert.ok(text.includes(t), t);
    }
});

test('coin conditions', () => {
    const ask = (text, coins) => condition({ npcId: WYSON, pages, text, player: player(coins) });
    assert.equal(ask("If the player has at least 15 coins:", 15), true);
    assert.equal(ask("If the player doesn't have 15 coins:", 15), false);
    assert.equal(ask("If the player doesn't have 20 coins:", 19), true);
    assert.equal(ask("If the player has at least 20 coins:", 19), false);
    assert.equal(condition({ npcId: 1, pages, text: "If the player has at least 15 coins:", player: player(15) }), null);
});

test('one leaf for 15 coins, two for 20; full inventory refunds', () => {
    const p = player(40);
    action({ npcId: WYSON, pages, action: 'receive', stepId: 'bywQsQ', player: p });
    assert.deepEqual([p.items.get(COINS), p.items.get(WOAD_LEAF)], [25, 1]);
    action({ npcId: WYSON, pages, action: 'receive', stepId: 'F6m-S9', player: p });
    assert.deepEqual([p.items.get(COINS), p.items.get(WOAD_LEAF)], [5, 3]);

    const full = player(20, false);
    const event = { npcId: WYSON, pages, action: 'receive', stepId: 'F6m-S9', player: full };
    action(event);
    assert.equal(full.items.get(COINS), 20);
    assert.equal(event.end, true);
});

const MOLE_PARTS_VARIANT = 'standard-dialogue-talking-to-wyson-with-mole-parts-in-inventory';
const IMMACULATE_VARIANT = 'standard-dialogue-talking-to-wyson-with-immaculate-mole-skin-in-inventory';
const NESTS = new Set([SEED_NEST, RING_NEST, EMPTY_NEST]);
const BOXES = new Map([[SEED_BOX, SEED_NEST], [RING_BOX, RING_NEST], [EMPTY_BOX, EMPTY_NEST]]);

/** Loose nests plus every nest held inside a box. */
function nestsHeld(p) {
    const loose = p.ids().filter((id) => NESTS.has(id)).length;
    const boxed = p.items.filter((item) => BOXES.has(item?.getId()))
        .reduce((n, box) => n + box.getMetaValue(BOX_META).count, 0);
    return loose + boxed;
}

test('the transcript has the mole-part variants and their trade action ids', () => {
    const variants = dialogues['Wyson the gardener'].variants;
    for (const [name, id] of [[MOLE_PARTS_VARIANT, 'T0rsOq'], [IMMACULATE_VARIANT, 'XwNH58']]) {
        assert.ok(JSON.stringify(variants[name]).includes(`"${id}"`), name);
    }
});

test('mole parts in the inventory open with the trade; an immaculate skin with its own line', () => {
    const pick = (ids, npcId = WYSON) => variant({ npcId, player: slotted(ids) });
    assert.deepEqual(pick([MOLE_CLAW]), { page: 'Wyson the gardener', variant: MOLE_PARTS_VARIANT });
    assert.deepEqual(pick([COINS, MOLE_SKIN]), { page: 'Wyson the gardener', variant: MOLE_PARTS_VARIANT });
    assert.deepEqual(pick([MOLE_CLAW, IMMACULATE_MOLE_SKIN]), { page: 'Wyson the gardener', variant: IMMACULATE_VARIANT });
    assert.deepEqual(pick([NOTED_MOLE_CLAW]), { page: 'Wyson the gardener', variant: MOLE_PARTS_VARIANT },
        'noted claws open the trade too');
    assert.deepEqual(pick([NOTED_MOLE_SKIN]), { page: 'Wyson the gardener', variant: MOLE_PARTS_VARIANT },
        'noted skins open the trade too');
    assert.deepEqual(pick([NOTED_IMMACULATE_MOLE_SKIN]), { page: 'Wyson the gardener', variant: IMMACULATE_VARIANT },
        'a noted immaculate skin opens the immaculate line');
    assert.equal(pick([COINS]), null, 'no parts: his standard dialogue');
    assert.equal(pick([MOLE_CLAW], 1), null, 'another NPC');
});

test('the parts come out and the nests fill the first free slots, as live', () => {
    // rsprox capture local 1000323, tick 13641: parts in 17, 18, 20, 24, 25, 26 with 14, 15, 21-23
    // and 27 free; the nests land in 14, 15, 17, 18, 20, 21 and 24-26 are cleared.
    const layout = Array(28).fill(COINS);
    for (const slot of [14, 15, 21, 22, 23, 27]) layout[slot] = null;
    for (const slot of [17, 20, 25]) layout[slot] = MOLE_CLAW;
    for (const slot of [18, 24, 26]) layout[slot] = MOLE_SKIN;
    const p = slotted(layout);
    const event = { npcId: WYSON, pages, stepId: 'T0rsOq', player: p };
    action(event);
    assert.equal(event.handled, true);
    const ids = p.ids();
    const nestSlots = ids.flatMap((id, slot) => (NESTS.has(id) ? [slot] : []));
    assert.deepEqual(nestSlots, [14, 15, 17, 18, 20, 21]);
    assert.deepEqual([ids[24], ids[25], ids[26]], [null, null, null]);
    assert.equal(ids.filter((id) => id === COINS).length, 16, 'nothing else moves');
    assert.equal(p.refreshed, 1);
    assert.deepEqual(p.messages, []);
});

test('an immaculate skin gives five nests; when they do not fit the overflow is boxed', (t) => {
    t.mock.method(Math, 'random', () => 0); // every roll a seed nest
    const p = slotted([IMMACULATE_MOLE_SKIN, MOLE_CLAW]);
    action({ npcId: WYSON, pages, stepId: 'XwNH58', player: p });
    assert.equal(p.ids().filter((id) => NESTS.has(id)).length, 6);
    assert.equal(p.getInventory().getAmount(IMMACULATE_MOLE_SKIN), 0);

    const full = slotted([IMMACULATE_MOLE_SKIN, MOLE_CLAW, ...Array(23).fill(COINS)]); // 3 free slots
    action({ npcId: WYSON, pages, stepId: 'XwNH58', player: full });
    assert.equal(full.getInventory().getAmount(IMMACULATE_MOLE_SKIN), 0, 'the skin is traded, not left behind');
    assert.equal(full.getInventory().getAmount(MOLE_CLAW), 0);
    assert.equal(nestsHeld(full), 6, 'all six nests are granted');
    const boxes = full.items.filter((item) => BOXES.has(item?.getId()));
    assert.equal(boxes.length, 1, 'the overflow is one seed box');
    assert.deepEqual(boxes[0].getMetaValue(BOX_META), { nest: SEED_NEST, count: 2 });
    assert.deepEqual(full.messages, []);
});

test('noted parts are paid in nest boxes, one per nest kind, holding any number', (t) => {
    // Seeds, ring, empty cycling: 4 seed + 3 ring + 3 empty from ten noted claws.
    const rolls = [0, 0.8, 0.95, 0, 0.8, 0.95, 0, 0.8, 0.95, 0];
    let roll = 0;
    t.mock.method(Math, 'random', () => rolls[roll++ % rolls.length]);
    const p = slotted([{ id: NOTED_MOLE_CLAW, amount: 10 }, COINS]);
    const event = { npcId: WYSON, pages, stepId: 'T0rsOq', player: p };
    action(event);
    assert.equal(event.handled, true);
    assert.equal(p.getInventory().getAmount(NOTED_MOLE_CLAW), 0, 'the noted stack comes out');
    assert.equal(p.ids().filter((id) => NESTS.has(id)).length, 0, 'noted parts give boxes, not loose nests');
    const boxes = new Map(p.items.filter((item) => BOXES.has(item?.getId()))
        .map((box) => [box.getMetaValue(BOX_META).nest, box.getMetaValue(BOX_META).count]));
    assert.deepEqual(Object.fromEntries(boxes), { [SEED_NEST]: 4, [RING_NEST]: 3, [EMPTY_NEST]: 3 });
    assert.equal([...boxes.values()].reduce((n, count) => n + count, 0), 10);
    assert.deepEqual(p.messages, []);
});

test('noted skin and noted immaculate skin give six nests in boxes', (t) => {
    t.mock.method(Math, 'random', () => 0);
    const p = slotted([NOTED_MOLE_SKIN, { id: NOTED_IMMACULATE_MOLE_SKIN, amount: 1 }, COINS]);
    action({ npcId: WYSON, pages, stepId: 'XwNH58', player: p });
    assert.equal(p.getInventory().getAmount(NOTED_MOLE_SKIN), 0);
    assert.equal(p.getInventory().getAmount(NOTED_IMMACULATE_MOLE_SKIN), 0);
    assert.equal(nestsHeld(p), 6);
    const boxes = p.items.filter((item) => BOXES.has(item?.getId()));
    assert.equal(boxes.length, 1);
    assert.deepEqual(boxes[0].getMetaValue(BOX_META), { nest: SEED_NEST, count: 6 });
});

test('a noted trade with no room for its boxes keeps the notes and says so', (t) => {
    // Seeds, ring, empty: three boxes would need three slots; only the stack's own slot frees.
    const rolls = [0, 0.8, 0.95, 0, 0.8, 0.95, 0, 0.8, 0.95, 0];
    let roll = 0;
    t.mock.method(Math, 'random', () => rolls[roll++ % rolls.length]);
    const p = slotted([{ id: NOTED_MOLE_CLAW, amount: 10 }, ...Array(27).fill(COINS)]);
    action({ npcId: WYSON, pages, stepId: 'T0rsOq', player: p });
    assert.equal(p.getInventory().getAmount(NOTED_MOLE_CLAW), 10, 'nothing is taken');
    assert.equal(p.ids().filter((id) => NESTS.has(id)).length, 0);
    assert.equal(p.items.filter((item) => BOXES.has(item?.getId())).length, 0);
    assert.deepEqual(p.messages, ["You don't have enough inventory space."]);
});

test('nests roll 72% seeds, 20% ring, 8% empty', (t) => {
    const rolled = (random) => {
        t.mock.method(Math, 'random', () => random);
        const p = slotted([MOLE_CLAW]);
        action({ npcId: WYSON, pages, stepId: 'T0rsOq', player: p });
        t.mock.restoreAll();
        return p.ids()[0];
    };
    assert.equal(rolled(0), SEED_NEST);
    assert.equal(rolled(0.7199), SEED_NEST);
    assert.equal(rolled(0.72), RING_NEST);
    assert.equal(rolled(0.9199), RING_NEST);
    assert.equal(rolled(0.92), EMPTY_NEST);
    assert.equal(rolled(0.9999), EMPTY_NEST);
});

test('other action steps and NPCs are left alone', () => {
    const p = slotted([MOLE_CLAW]);
    const other = { npcId: WYSON, pages, stepId: 'zzzzzz', player: p };
    action(other);
    const notWyson = { npcId: 1, pages, stepId: 'T0rsOq', player: p };
    action(notWyson);
    assert.deepEqual([other.handled, notWyson.handled, p.ids()[0]], [undefined, undefined, MOLE_CLAW]);
});

test('free worlds keep the ordinary dialogue even when carrying mole parts', (t) => {
    membersWorld = false;
    t.after(() => { membersWorld = true; });
    for (const id of [MOLE_CLAW, MOLE_SKIN, IMMACULATE_MOLE_SKIN,
        NOTED_MOLE_CLAW, NOTED_MOLE_SKIN, NOTED_IMMACULATE_MOLE_SKIN]) {
        assert.equal(variant({ npcId: WYSON, player: slotted([id]) }), null);
    }
});

test('a mole trade selected on a members world cannot commit or replay after membership changes', (t) => {
    t.after(() => { membersWorld = true; });
    const p = slotted([MOLE_CLAW, MOLE_SKIN, IMMACULATE_MOLE_SKIN, COINS]);
    assert.equal(variant({ npcId: WYSON, player: p }).variant, IMMACULATE_VARIANT);
    const before = p.ids();
    membersWorld = false;
    for (const stepId of ['XwNH58', 'T0rsOq', 'XwNH58']) {
        const event = { npcId: WYSON, pages, stepId, player: p };
        action(event);
        assert.deepEqual(p.ids(), before, 'blocked commit preserves every inventory slot');
        assert.equal(event.handled, true);
        assert.equal(event.end, true, 'stale trade dialogue ends');
    }
    assert.equal(p.refreshed, 0);
});

test('free-world woad sales still exchange twenty coins for two leaves', (t) => {
    membersWorld = false;
    t.after(() => { membersWorld = true; });
    const p = player(20);
    action({ npcId: WYSON, pages, action: 'receive', stepId: 'F6m-S9', player: p });
    assert.deepEqual([p.items.get(COINS), p.items.get(WOAD_LEAF)], [0, 2]);
});
