// node --test tests/nest-box.test.cjs
// Nest boxes (Wiki "Nest box", Update "Content Poll 25 - Batch 1"): Check names the kind and
// count; Extract needs a bank or the Grand Exchange and moves nests to the inventory, leaving
// what does not fit boxed. The exact live messages are unrecorded, so those are ours.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const NestBox = require('../plugins/items/NestBox.plugin');
const { makeBox } = require('../plugins/items/nest-boxes');

const SEED_NEST = 22800, RING_NEST = 5074, EMPTY_NEST = 5075;
const SEED_BOX = 23062, RING_BOX = 12794, EMPTY_BOX = 12792;
const BOX_META = 'wyson:nest-box';
const GRAND_EXCHANGE = 465, INVENTORY_INTERFACE = 5064;
const NO_ROOM = "You don't have enough inventory space.";
const REFUSAL = "You can only extract nests from a nest box inside a bank or at the Grand Exchange.";

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
class DialogueChainBuilder {
    constructor() { this.entries = []; }
    add(entry) { this.entries.push(entry); return this; }
}
class ItemStatementDialogue {
    constructor(type, itemId, text) { this.type = type; this.itemId = itemId; this.text = text; }
}
const core = {
    Item,
    DialogueChainBuilder,
    ItemStatementDialogue,
    Bank: { isOpen: (player) => player.bankOpen === true },
    ItemIdentifiers: {
        BIRD_NEST_12: SEED_NEST, BIRD_NEST_5: RING_NEST, BIRD_NEST_6: EMPTY_NEST,
        NEST_BOX_SEEDS__4: SEED_BOX, NEST_BOX_RING_: RING_BOX, NEST_BOX_EMPTY_: EMPTY_BOX,
    },
};
const actions = {};
const custom = {};
NestBox.register({
    core,
    onItemAction: (name, handlers) => { actions[name] = { ...actions[name], ...handlers }; },
    onCustomEvent: (name, handler) => { custom[name] = handler; },
});

function player({ entries = [], bankOpen = false, interfaceId = INVENTORY_INTERFACE } = {}) {
    const items = Array.from({ length: 28 }, (_, slot) => {
        const entry = entries[slot];
        if (!entry) return null;
        return typeof entry === 'number' ? new Item(entry) : entry;
    });
    const p = {
        messages: [],
        bankOpen,
        interfaceId,
        refreshed: 0,
        started: null,
        sendMessage(message) { this.messages.push(message); },
        getInterfaceId() { return this.interfaceId; },
        getInventory: () => ({
            getItems: () => items,
            getFreeSlots: () => items.filter((item) => !item).length,
            deleteAtSlot: (slot, amount = 1) => {
                const item = items[slot];
                if (!item) return;
                if (item.getAmount() <= amount) items[slot] = null; else item.amount -= amount;
            },
            add: (item) => { const slot = items.findIndex((each) => !each); if (slot >= 0) items[slot] = item; },
            refreshItems: () => { p.refreshed++; },
        }),
        getDialogueManager: () => ({
            startDialogues: (chain) => { p.started = chain; },
        }),
    };
    return p;
}

const slotOf = (p, item) => p.getInventory().getItems().indexOf(item);
const act = (p, item, option) => actions[item.getDefinition?.()?.getName?.() ?? nameOf(item)][option]({
    player: p, item, itemId: item.getId(), slot: slotOf(p, item),
});
const nameOf = (item) => {
    if (item.getId() === SEED_BOX) return 'Nest box (seeds)';
    if (item.getId() === RING_BOX) return 'Nest box (ring)';
    return 'Nest box (empty)';
};
const box = (nestId, count) => makeBox(core, nestId, count);

test('Check names the kind and count in an item box', () => {
    for (const [nest, count, text] of [
        [SEED_NEST, 5, 'The nest box contains 5 seed nests.'],
        [RING_NEST, 1, 'The nest box contains 1 ring nest.'],
        [EMPTY_NEST, 3, 'The nest box contains 3 empty nests.'],
    ]) {
        const p = player({ entries: [box(nest, count)] });
        const item = p.getInventory().getItems()[0];
        act(p, item, 'Check');
        assert.equal(p.started.entries[0].text, text);
        assert.equal(p.started.entries[0].itemId, item.getId());
    }
});

test('Extract inside a bank moves every nest into the inventory and removes the box', () => {
    const p = player({ entries: [box(SEED_NEST, 3), 995], bankOpen: true });
    const item = p.getInventory().getItems()[0];
    act(p, item, 'Extract');
    assert.equal(p.getInventory().getFreeSlots(), 24, 'two items became four nests');
    assert.equal(p.getInventory().getItems().filter((held) => held?.getId() === SEED_NEST).length, 3);
    assert.equal(p.getInventory().getItems().some((held) => held?.getId() === SEED_BOX), false);
    assert.equal(p.refreshed, 1);
    assert.deepEqual(p.messages, []);
});

test('Extract at the Grand Exchange is allowed too', () => {
    const p = player({ entries: [box(RING_NEST, 2)], interfaceId: GRAND_EXCHANGE });
    act(p, p.getInventory().getItems()[0], 'Extract');
    assert.equal(p.getInventory().getItems().filter((held) => held?.getId() === RING_NEST).length, 2);
    assert.deepEqual(p.messages, []);
});

test('Extract elsewhere refuses and leaves the box untouched', () => {
    const p = player({ entries: [box(SEED_NEST, 2)] });
    act(p, p.getInventory().getItems()[0], 'Extract');
    assert.deepEqual(p.getInventory().getItems().filter(Boolean).map((held) => held.getId()), [SEED_BOX]);
    assert.deepEqual(p.messages, [REFUSAL]);
    assert.equal(p.getInventory().getItems()[0].getMetaValue(BOX_META).count, 2);
});

test('a full inventory leaves the rest boxed and says so', () => {
    const entries = [box(SEED_NEST, 5), ...Array(27).fill(995)]; // 28 slots, none free
    const p = player({ entries, bankOpen: true });
    act(p, p.getInventory().getItems()[0], 'Extract');
    assert.equal(p.getInventory().getItems().filter((held) => held?.getId() === SEED_NEST).length, 0,
        'no room at all, so nothing moves');
    assert.equal(p.getInventory().getItems()[0].getMetaValue(BOX_META).count, 5);
    assert.deepEqual(p.messages, [NO_ROOM]);
});

test('Extract takes the box slot into account when the contents just fit', () => {
    const entries = [box(SEED_NEST, 1), ...Array(27).fill(995)]; // full except the box's nest
    const p = player({ entries, bankOpen: true });
    act(p, p.getInventory().getItems()[0], 'Extract');
    assert.equal(p.getInventory().getItems().filter((held) => held?.getId() === SEED_NEST).length, 1);
    assert.equal(p.getInventory().getItems().some((held) => held?.getId() === SEED_BOX), false);
    assert.deepEqual(p.messages, []);
});

test('unknown boxes are left to the core', () => {
    const p = player({ entries: [12793], bankOpen: true });
    assert.equal(actions['Nest box (empty)'].Check({ player: p, item: p.getInventory().getItems()[0], slot: 0 }), false);
});

test('bank side op 9 (the cache param-595 "Extract") extracts without closing the bank', () => {
    const p = player({ entries: [box(SEED_NEST, 4), 995], bankOpen: true });
    const item = p.getInventory().getItems()[0];
    const event = { player: p, item, slot: 0, op: 9, handled: false };
    custom['bank:inventory-op'](event);
    assert.equal(event.handled, true);
    assert.equal(p.getInventory().getItems().filter((held) => held?.getId() === SEED_NEST).length, 4);
    assert.equal(p.getInventory().getItems().some((held) => held?.getId() === SEED_BOX), false);
    assert.equal(p.refreshed, 1);
    assert.deepEqual(p.messages, []);
});

test('bank side deposit ops leave the box for the bank', () => {
    const p = player({ entries: [box(SEED_NEST, 2)], bankOpen: true });
    const item = p.getInventory().getItems()[0];
    const event = { player: p, item, slot: 0, op: 2, handled: false };
    custom['bank:inventory-op'](event);
    assert.equal(event.handled, false);
    assert.equal(p.getInventory().getItems()[0], item);
    assert.equal(p.refreshed, 0);
});

test('a full inventory still claims the bank Extract so the box is not deposited', () => {
    const entries = [box(SEED_NEST, 5), ...Array(27).fill(995)];
    const p = player({ entries, bankOpen: true });
    const item = p.getInventory().getItems()[0];
    const event = { player: p, item, slot: 0, op: 9, handled: false };
    custom['bank:inventory-op'](event);
    assert.equal(event.handled, true);
    assert.equal(item.getMetaValue(BOX_META).count, 5);
    assert.deepEqual(p.messages, [NO_ROOM]);
});

test('bank side op 9 on another item is left to the bank', () => {
    const p = player({ entries: [995], bankOpen: true });
    const item = p.getInventory().getItems()[0];
    const event = { player: p, item, slot: 0, op: 9, handled: false };
    custom['bank:inventory-op'](event);
    assert.equal(event.handled, false);
});
