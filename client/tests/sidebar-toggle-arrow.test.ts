import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { SidebarStore } from "../game/sidebar/SidebarStore";
import { SidebarToggleArrow } from "../game/sidebar/SidebarToggleArrow";

// The arrow shares the minimap's top-right corner. An invisible arrow must not take that
// click (it used to hide the sidebar instead of opening the map), and a hidden sidebar must
// always show the arrow that brings it back.
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
});
Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

function cssRule(selector: string): string {
    const css = readFileSync(path.resolve(__dirname, "../game/sidebar/Sidebar.css"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selectors = match[1].split(",").map((part) => part.trim());
        if (selectors.includes(selector)) return match[2];
    }
    return "";
}

const rootNode = document.getElementById("root")!;
const root = createRoot(rootNode);
const store = new SidebarStore();
const button = (): HTMLButtonElement => rootNode.querySelector<HTMLButtonElement>(".rl-sidebar-toggle")!;
const zone = (): HTMLElement => rootNode.querySelector<HTMLElement>(".rl-sidebar-toggle-zone")!;

void (async () => {
    await React.act(async () => {
        root.render(React.createElement(SidebarToggleArrow, { store }));
    });
    assert.equal(button().className, "rl-sidebar-toggle close", "open: the close arrow waits for the edge");
    assert.equal(button().getAttribute("aria-label"), "Close sidebar");
    assert.doesNotMatch(zone().className, /\bnear\b/);

    await React.act(async () => {
        dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 0, clientY: 0 }));
    });
    assert.match(zone().className, /\bnear\b/, "the pointer at the game's right edge shows the arrow");

    await React.act(async () => store.setCollapsed(true));
    assert.equal(button().className, "rl-sidebar-toggle collapsed", "collapsed: the reopen arrow shows");
    assert.equal(button().getAttribute("aria-label"), "Open sidebar");

    // The stylesheet is what makes the classes above mean "visible" and "clickable".
    assert.match(cssRule(".rl-sidebar-toggle"), /pointer-events:\s*none/, "a hidden arrow is not a click target");
    assert.match(cssRule(".rl-sidebar-toggle-zone.near .rl-sidebar-toggle"), /pointer-events:\s*auto/);
    assert.match(cssRule(".rl-sidebar-toggle.collapsed"), /opacity:\s*1/);
    assert.match(cssRule(".rl-sidebar-toggle.collapsed"), /pointer-events:\s*auto/);

    await React.act(async () => root.unmount());
    console.log("sidebar-toggle-arrow.test.ts: all tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
