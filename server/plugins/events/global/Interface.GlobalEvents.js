"use strict";

/**
 * The ::events widget group: three tabs over one shared virtual list, with the selected row's
 * details in a side panel and Toggle / Claim / Activate acting on that selection. It uses the
 * same custom-interface runtime as ::teleports and ::commands, so scrolling, tab switching and
 * the instant panel fill need no client-side knowledge of Global Events.
 */

const { FLAG_OP1, TYPE_GRAPHIC, TYPE_RECTANGLE, TYPE_TEXT, createWidgetGroup } = require("../../interface/widgetGroup");

const GROUP_ID = 30012;
const MAIN_MODAL_UID = (161 << 16) | 16;
const TAB = Object.freeze({ ACTIVE: "active", CLAIMABLE: "claimable", TOKENS: "tokens" });
const TAB_ORDER = [TAB.ACTIVE, TAB.CLAIMABLE, TAB.TOKENS];
const TAB_LABELS = { [TAB.ACTIVE]: "Active", [TAB.CLAIMABLE]: "Claimable", [TAB.TOKENS]: "Tokens" };
const COMPONENT = {
  ROOT: 0, FRAME: 1, STATUS: 2, DATA: 3, LAYOUT: 4, LIST_VIEW: 5, LIST_SCROLLBAR: 6,
  PANEL: 7, PANEL_ICON: 8, PANEL_TITLE: 9, PANEL_SUBTITLE: 10, PANEL_INFO: 11, PANEL_INFO2: 12,
  PANEL_DESCRIPTION: 13, TOGGLE_BUTTON: 14, TOGGLE_LABEL: 15, CLAIM_BUTTON: 16, CLAIM_LABEL: 17,
  ACTIVATE_BUTTON: 18, ACTIVATE_LABEL: 19, TAB_START: 20, TAB_LABEL_START: 30,
  ROW_BACKGROUND_START: 40, ROW_ICON_START: 60, ROW_LABEL_START: 80,
};
const TAB_COUNT = TAB_ORDER.length;
const TAB_WIDTH = 110;
const TAB_STEP = 114;
const ROW_SLOTS = 10;
const ROW_HEIGHT = 26;
const LIST = { x: 18, y: 100, width: 274, height: 210 };
const PANEL = { x: 306, y: 56, width: 176, height: 254 };
const ROW_ACTIONS = ["Select"];
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
    add(COMPONENT.TAB_START + index, root, box(x, 32, TAB_WIDTH, 20, {
      color: 0x2b241b, mouseOverColor: 0x3a3125, actions: ["Open"], flags: FLAG_OP1,
    }));
    add(COMPONENT.TAB_LABEL_START + index, root, text(x, 32, TAB_WIDTH, 20, {
      textColor: 0xffd27f, xTextAlignment: 1, yTextAlignment: 1,
    }));
  }
}

function addList(add, root) {
  add(COMPONENT.STATUS, root, text(18, 78, 274, 16, { textColor: 0xffd27f, yTextAlignment: 1 }));
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
      type: TYPE_GRAPHIC, rawX: 3, rawY: 0, rawWidth: 24, rawHeight: 22, width: 24, height: 22, itemQuantityMode: 0,
    });
    add(COMPONENT.ROW_LABEL_START + slot, list, text(32, 0, LIST.width - 38, ROW_HEIGHT - 2, {
      yTextAlignment: 1, actions: ROW_ACTIONS, flags: FLAG_OP1,
    }));
  }
}

function addPanel(add, root) {
  const { x, y, width, height } = PANEL;
  add(COMPONENT.PANEL, root, box(x, y, width, height));
  add(COMPONENT.PANEL_ICON, root, { type: TYPE_GRAPHIC, rawX: x + 6, rawY: y + 6, rawWidth: 36, rawHeight: 32, width: 36, height: 32, itemQuantityMode: 0 });
  add(COMPONENT.PANEL_TITLE, root, text(x + 46, y + 4, width - 52, 20, { fontId: 496, textColor: 0xff981f, yTextAlignment: 1 }));
  add(COMPONENT.PANEL_SUBTITLE, root, text(x + 46, y + 22, width - 52, 16, { textColor: 0xb8ab94, yTextAlignment: 1 }));
  add(COMPONENT.PANEL_INFO, root, text(x + 6, y + 44, width - 12, 16));
  add(COMPONENT.PANEL_INFO2, root, text(x + 6, y + 60, width - 12, 16));
  add(COMPONENT.PANEL_DESCRIPTION, root, text(x + 6, y + 80, width - 12, height - 104));
  const buttonWidth = 52;
  const buttonY = y + height + 4;
  const buttons = [
    [COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL, "Toggle", "Toggle effects"],
    [COMPONENT.CLAIM_BUTTON, COMPONENT.CLAIM_LABEL, "Claim", "Claim item"],
    [COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL, "Activate", "Activate event"],
  ];
  buttons.forEach(([button, label, caption, action], index) => {
    const at = x + 6 + index * (buttonWidth + 4);
    add(button, root, box(at, buttonY, buttonWidth, 22, {
      color: 0x3b2f20, mouseOverColor: 0x54432c, actions: [action], flags: FLAG_OP1,
    }));
    add(label, root, text(at, buttonY, buttonWidth, 22, {
      text: caption, textColor: 0xffd27f, xTextAlignment: 1, yTextAlignment: 1,
    }));
  });
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
    list: {
      viewComponent: COMPONENT.LIST_VIEW,
      scrollbarComponent: COMPONENT.LIST_SCROLLBAR,
      slotCount: ROW_SLOTS,
      columns: 1,
      rowHeight: ROW_HEIGHT,
      backgroundStart: COMPONENT.ROW_BACKGROUND_START,
      iconStart: COMPONENT.ROW_ICON_START,
      iconBaseY: 1,
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
          description: COMPONENT.PANEL_DESCRIPTION,
        },
        iconComponent: COMPONENT.PANEL_ICON,
        showComponents: [
          COMPONENT.TOGGLE_BUTTON, COMPONENT.TOGGLE_LABEL,
          COMPONENT.CLAIM_BUTTON, COMPONENT.CLAIM_LABEL,
          COMPONENT.ACTIVATE_BUTTON, COMPONENT.ACTIVATE_LABEL,
        ],
      },
    },
    status: { component: COMPONENT.STATUS, matches: "Events: %total", empty: "Nothing to show in this tab." },
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
  TAB_UIDS,
  TAB_LABEL_UIDS,
  ROW_UIDS,
  ROW_SLOTS,
  uid,
  buildInterface,
};
