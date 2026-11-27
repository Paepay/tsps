"use strict";

/**
 * The ::events widget group: three tabs (Live, Activate, Claimable) over one shared virtual
 * list, with the selected row's details in a side panel and one wide action button under it.
 * It uses the same custom-interface runtime as ::teleports and ::commands, so scrolling, tab
 * switching and the instant panel fill need no client-side knowledge of Global Events.
 *
 * - Live: one row per category slot, showing the running event with the same countdown the
 *   website's /play page shows, or an "empty" row when nothing runs in that slot.
 * - Activate: every event, grouped by category, with the player's token count.
 * - Claimable: the temporary event items the player can claim.
 *
 * Row icons are the website's Combat / Skilling / Utility symbols, served as server sprites
 * (server/data/sprites/301xx, 3011x), so the game and the website show the same artwork.
 */

const { FLAG_OP1, TYPE_GRAPHIC, TYPE_RECTANGLE, TYPE_TEXT, createWidgetGroup } = require("../../interface/widgetGroup");

const GROUP_ID = 30012;
const MAIN_MODAL_UID = (161 << 16) | 16;
const TAB = Object.freeze({ LIVE: "active", ACTIVATE: "activate", CLAIMABLE: "claimable" });
const TAB_ORDER = [TAB.LIVE, TAB.ACTIVATE, TAB.CLAIMABLE];
const TAB_LABELS = { [TAB.LIVE]: "Live", [TAB.ACTIVATE]: "Activate", [TAB.CLAIMABLE]: "Claimable" };
const COMPONENT = {
  ROOT: 0, FRAME: 1, DATA: 3, LAYOUT: 4, LIST_VIEW: 5, LIST_SCROLLBAR: 6,
  PANEL: 7, PANEL_ICON: 8, PANEL_TITLE: 9, PANEL_SUBTITLE: 10, PANEL_INFO: 11, PANEL_INFO2: 12,
  PANEL_DESCRIPTION: 13, TOGGLE_BUTTON: 14, TOGGLE_LABEL: 15, CLAIM_BUTTON: 16, CLAIM_LABEL: 17,
  ACTIVATE_BUTTON: 18, ACTIVATE_LABEL: 19, TAB_START: 20, TAB_LABEL_START: 30,
  ROW_BACKGROUND_START: 40, ROW_ICON_START: 60, ROW_LABEL_START: 80, PANEL_INFO3: 90, PANEL_RULE: 91,
};
const TAB_COUNT = TAB_ORDER.length;
const TAB_WIDTH = 90;
const TAB_HEIGHT = 20;
const TAB_STEP = 94;
const TAB_Y = 28;
const ROW_SLOTS = 10;
const ROW_HEIGHT = 26;
// The modal frame draws about 310 px tall whatever the root's height says, so everything,
// including the action button under the panel, has to end by y = 304 to sit inside it.
const LIST = { x: 18, y: 54, width: 274, height: 250 };
const PANEL = { x: 306, y: 28, width: 176, height: 250 };
const ROW_ACTIONS = ["Select"];

/**
 * The website's category symbols as server sprites: 22x22 for list rows and 32x32 for the
 * details panel. The ids sit in the server-sprite range (30000+) and must match the PNG file
 * names in server/data/sprites.
 */
const SPRITE = Object.freeze({
  ROW: Object.freeze({ combat: 30101, skilling: 30102, utility: 30103 }),
  PANEL: Object.freeze({ combat: 30111, skilling: 30112, utility: 30113 }),
});
const ROW_ICON_SIZE = 22;
const PANEL_ICON_SIZE = 32;

const uid = (component) => (GROUP_ID << 16) | component;
const TAB_UIDS = TAB_ORDER.map((_, index) => uid(COMPONENT.TAB_START + index));
const TAB_LABEL_UIDS = TAB_ORDER.map((_, index) => uid(COMPONENT.TAB_LABEL_START + index));
const ROW_UIDS = Array.from({ length: ROW_SLOTS }, (_, slot) => uid(COMPONENT.ROW_LABEL_START + slot));

const text = (x, y, width, height, overrides = {}) => ({
  type: TYPE_TEXT, rawX: x, rawY: y, rawWidth: width, rawHeight: height, width, height,
  text: "", fontId: 494, textColor: 0xe8ded0, textShadowed: true, ...overrides,
});
const box = (x, y, width, height, overrides = {}) => ({
  type: TYPE_RECTANGLE, rawX: x, rawY: y, rawWidth: width, rawHeight: height, width, height,
  filled: true, color: 0x211b16, opacity: 32, ...overrides,
});

function addTabs(add, root) {
  for (let index = 0; index < TAB_COUNT; index++) {
    const x = 18 + index * TAB_STEP;
    add(COMPONENT.TAB_START + index, root, box(x, TAB_Y, TAB_WIDTH, TAB_HEIGHT, {
      color: 0x2b241b, mouseOverColor: 0x3a3125, actions: ["Open"], flags: FLAG_OP1,
    }));
    add(COMPONENT.TAB_LABEL_START + index, root, text(x, TAB_Y, TAB_WIDTH, TAB_HEIGHT, {
      textColor: 0xffd27f, xTextAlignment: 1, yTextAlignment: 1,
    }));
  }
}

function addList(add, root) {
  add(COMPONENT.DATA, root, { type: TYPE_TEXT, hidden: true, isHidden: true });
  add(COMPONENT.LAYOUT, root, { type: TYPE_TEXT, hidden: true, isHidden: true });
  const list = add(COMPONENT.LIST_VIEW, root, {
    rawX: LIST.x, rawY: LIST.y, rawWidth: LIST.width, rawHeight: LIST.height,
    width: LIST.width, height: LIST.height, scrollWidth: LIST.width, scrollHeight: LIST.height,
  });
  add(COMPONENT.LIST_SCROLLBAR, root, {
    rawX: LIST.x + LIST.width, rawY: LIST.y, rawWidth: 16, rawHeight: LIST.height,
    width: 16, height: LIST.height, noClickThrough: true,
  });
  for (let slot = 0; slot < ROW_SLOTS; slot++) {
    add(COMPONENT.ROW_BACKGROUND_START + slot, list, box(0, 0, LIST.width - 2, ROW_HEIGHT - 2, { mouseOverColor: 0x3a3125 }));
    add(COMPONENT.ROW_ICON_START + slot, list, {
      type: TYPE_GRAPHIC, rawX: 4, rawY: 0, rawWidth: ROW_ICON_SIZE, rawHeight: ROW_ICON_SIZE,
      width: ROW_ICON_SIZE, height: ROW_ICON_SIZE, itemQuantityMode: 0,
    });
    add(COMPONENT.ROW_LABEL_START + slot, list, text(32, 0, LIST.width - 38, ROW_HEIGHT - 2, {
      yTextAlignment: 1, actions: ROW_ACTIONS, flags: FLAG_OP1,
    }));
  }
}

function addPanel(add, root) {
  const { x, y, width, height } = PANEL;
  add(COMPONENT.PANEL, root, box(x, y, width, height));
  add(COMPONENT.PANEL_ICON, root, {
    type: TYPE_GRAPHIC, rawX: x + 6, rawY: y + 6, rawWidth: PANEL_ICON_SIZE, rawHeight: PANEL_ICON_SIZE,
    width: PANEL_ICON_SIZE, height: PANEL_ICON_SIZE, itemQuantityMode: 0,
  });
  add(COMPONENT.PANEL_TITLE, root, text(x + 44, y + 5, width - 50, 18, { fontId: 496, textColor: 0xff981f, yTextAlignment: 1 }));
  add(COMPONENT.PANEL_SUBTITLE, root, text(x + 44, y + 23, width - 50, 16, { textColor: 0xb8ab94, yTextAlignment: 1 }));
  add(COMPONENT.PANEL_RULE, root, box(x + 6, y + 43, width - 12, 1, { color: 0x6b5a3c, opacity: 0 }));
  add(COMPONENT.PANEL_INFO, root, text(x + 6, y + 48, width - 12, 14, { textColor: 0xffd27f }));
  add(COMPONENT.PANEL_INFO2, root, text(x + 6, y + 62, width - 12, 14));
  add(COMPONENT.PANEL_INFO3, root, text(x + 6, y + 76, width - 12, 14));
  add(COMPONENT.PANEL_DESCRIPTION, root, text(x + 6, y + 96, width - 12, height - 102, { textColor: 0xcfc4b0 }));

  // One wide action button under the panel. The three buttons share its place; each row's
  // `show` list picks the one that applies, and the server writes its caption (for example
  // "Disable for me" / "Enable for me"). They start hidden: nothing is selected yet.
  const buttonY = y + height + 4;
  const buttons = [
    [COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL, "Disable for me", "Toggle effects for me"],
    [COMPONENT.CLAIM_BUTTON, COMPONENT.CLAIM_LABEL, "Claim item", "Claim item"],
    [COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL, "Activate", "Activate event"],
  ];
  for (const [button, label, caption, action] of buttons) {
    add(button, root, box(x, buttonY, width, 22, {
      color: 0x3b2f20, mouseOverColor: 0x54432c, actions: [action], flags: FLAG_OP1, hidden: true, isHidden: true,
    }));
    add(label, root, text(x, buttonY, width, 22, {
      text: caption, textColor: 0xffd27f, xTextAlignment: 1, yTextAlignment: 1, hidden: true, isHidden: true,
    }));
  }
}

function buildInterface() {
  const { widgets, add } = createWidgetGroup(GROUP_ID);
  const root = add(COMPONENT.ROOT, -1, {
    rawWidth: 18, rawHeight: 18, widthMode: 1, heightMode: 1,
    width: 494, height: 340, xPositionMode: 1, yPositionMode: 1,
  });
  add(COMPONENT.FRAME, root, { widthMode: 1, heightMode: 1, width: 494, height: 340 });
  addTabs(add, root);
  addList(add, root);
  addPanel(add, root);
  return {
    groupId: GROUP_ID,
    widgets,
    // Tabbed lists keep every row in one catalog even without a search box; the runtime
    // needs the component named so it can parse the rows and draw the tabs.
    dataComponent: COMPONENT.DATA,
    list: {
      viewComponent: COMPONENT.LIST_VIEW,
      scrollbarComponent: COMPONENT.LIST_SCROLLBAR,
      slotCount: ROW_SLOTS,
      columns: 1,
      rowHeight: ROW_HEIGHT,
      backgroundStart: COMPONENT.ROW_BACKGROUND_START,
      iconStart: COMPONENT.ROW_ICON_START,
      iconBaseY: 2,
      labelStart: COMPONENT.ROW_LABEL_START,
      itemLabel: "%name<col=ffd27f>%detail</col>",
      headerLabel: "<col=ff981f>%name</col>",
      clickable: true,
      select: {
        op: 1,
        texts: {
          title: COMPONENT.PANEL_TITLE,
          subtitle: COMPONENT.PANEL_SUBTITLE,
          info: COMPONENT.PANEL_INFO,
          info2: COMPONENT.PANEL_INFO2,
          info3: COMPONENT.PANEL_INFO3,
          description: COMPONENT.PANEL_DESCRIPTION,
          toggle: COMPONENT.TOGGLE_LABEL,
          activate: COMPONENT.ACTIVATE_LABEL,
        },
        iconComponent: COMPONENT.PANEL_ICON,
        showComponents: [
          COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL,
          COMPONENT.CLAIM_BUTTON, COMPONENT.CLAIM_LABEL,
          COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL,
        ],
      },
    },
    tabs: {
      components: TAB_ORDER.map((_, index) => COMPONENT.TAB_START + index),
      labelComponents: TAB_ORDER.map((_, index) => COMPONENT.TAB_LABEL_START + index),
      labels: TAB_ORDER.map((tab) => TAB_LABELS[tab]),
      activeTemplate: "<col=ffffff>%s</col>",
      inactiveTemplate: "<col=ffd27f>%s</col>",
      layoutComponent: COMPONENT.LAYOUT,
      clearQuery: false,
    },
  };
}

module.exports = {
  GROUP_ID,
  MAIN_MODAL_UID,
  TAB,
  TAB_ORDER,
  TAB_LABELS,
  COMPONENT,
  SPRITE,
  TAB_UIDS,
  TAB_LABEL_UIDS,
  ROW_UIDS,
  ROW_SLOTS,
  uid,
  buildInterface,
};
