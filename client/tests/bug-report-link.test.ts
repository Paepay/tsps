import { strict as assert } from "node:assert";

import {
    BUG_REPORT_ISSUE_URL,
    ISSUE_TAB_NOTICE,
    MAX_ISSUE_URL_LENGTH,
    buildIssueUrl,
    coarseBrowser,
    formatDiagnosticsSection,
    formatErrorLines,
    openIssueTab,
    redactAddresses,
    resolveCopyFrame,
    resolvePlayer,
    truncateCodePoints,
} from "../game/plugins/bugreport/bugReportLink";
import type { BugReportDiagnostics } from "../game/plugins/bugreport/bugReportLink";

function baseDiagnostics(): BugReportDiagnostics {
    return {
        loggedIn: true,
        player: "Zezima",
        position: { x: 3200, y: 3200, plane: 0 },
        world: "Local Development",
        worldId: "1",
        members: true,
        tick: 1234,
        transport: "websocket",
        renderer: "WebGL",
        viewport: "1920x1080 @1x",
        fps: 50,
        mobile: false,
        cache: "rev 231",
        failedPlugins: {},
        errors: "[warn] something creaked",
        skills: "total 2277 (combat 126): Attack 99",
        inventory: "Coins x1000",
        equipment: "Abyssal whip",
        varps: "3 set: 1=1",
        interfaces: "root 378 (2 open)",
        messages: ["Welcome to tsps."],
    };
}

function testTruncation(): void {
    assert.equal(truncateCodePoints("abc", 5), "abc");
    // An emoji at units 79-80 of a UTF-16 cut would lose half of itself; code points keep it whole.
    const emoji = "a".repeat(79) + "🙂";
    assert.equal(Array.from(truncateCodePoints(emoji, 80)).length, 80);
    assert.ok(truncateCodePoints(emoji, 80).endsWith("🙂"));
    assert.ok(!truncateCodePoints(`${emoji}tail`, 80).includes("�"));
}

function testRedaction(): void {
    assert.equal(redactAddresses("ws://192.168.1.10:43594/game"), "ws://(address left out):43594/game");
    assert.equal(redactAddresses("candidate 10.0.0.5:54321"), "candidate (address left out):54321");
    assert.ok(redactAddresses("fe80::1ff:fe23:4567:890a").includes("(address left out)"), ":: form redacted");
    assert.ok(
        redactAddresses("ping [2001:db8::1]:80 ok").includes("(address left out)"),
        "bracketed :: form redacted",
    );
    assert.ok(
        redactAddresses("up 1:2:3:4:5:6:7:8 done").includes("(address left out)"),
        "full eight-group form redacted",
    );
    // Narrower colon shapes are stack frames and timestamps: the line numbers stay.
    assert.equal(redactAddresses("at open (Foo.ts:123:45)"), "at open (Foo.ts:123:45)");
    assert.equal(redactAddresses("uptime 12:30:45 ok"), "uptime 12:30:45 ok");
    assert.equal(redactAddresses("ratio 1:2 kept"), "ratio 1:2 kept");
    assert.equal(redactAddresses("nothing to hide"), "nothing to hide");
}

function testResolvePlayer(): void {
    // A logout keeps the old name on the client; the report must not repeat it.
    assert.deepEqual(resolvePlayer(false, "Zezima", { x: 1, y: 2, plane: 0 }), {
        name: "(logged out)",
        position: undefined,
    });
    assert.deepEqual(resolvePlayer(true, "Zezima", { x: 1, y: 2, plane: 0 }), {
        name: "Zezima",
        position: { x: 1, y: 2, plane: 0 },
    });
    assert.equal(resolvePlayer(true, "  ", undefined).name, "(unknown)");
}

function testCoarseBrowser(): void {
    const chrome =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    assert.equal(coarseBrowser(chrome), "Chrome");
    assert.equal(coarseBrowser("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"), "Firefox");
    assert.equal(coarseBrowser("经过"), "Other");
}

function testResolveCopyFrame(): void {
    const previous = "old-session-frame";
    const fresh = "fresh-frame";
    // A fresh capture always wins.
    assert.equal(
        resolveCopyFrame({ fresh, previous, expectedGeneration: 2, generation: 2, loggedIn: true }),
        fresh,
    );
    // A capture that produced nothing falls back to the pre-click frame within the same session.
    assert.equal(
        resolveCopyFrame({ fresh: undefined, previous, expectedGeneration: 2, generation: 2, loggedIn: true }),
        previous,
    );
    // Logout while Copy awaited a frame bumps the generation: the old frame must not come back.
    assert.equal(
        resolveCopyFrame({ fresh: undefined, previous, expectedGeneration: 2, generation: 3, loggedIn: false }),
        undefined,
    );
    // Same for a logout that was observed even if the generation happened to match.
    assert.equal(
        resolveCopyFrame({ fresh: undefined, previous, expectedGeneration: 2, generation: 2, loggedIn: false }),
        undefined,
    );
}

function testOpenIssueTab(): void {
    // window.open with `noopener` returns null on success (Chrome hides the handle), so a
    // null return must never be reported as a blocked popup.
    const opened: string[] = [];
    const notice = openIssueTab("https://example.test/issue", (url) => {
        opened.push(url);
        return null;
    });
    assert.deepEqual(opened, ["https://example.test/issue"], "the url is opened once");
    assert.equal(notice, ISSUE_TAB_NOTICE);
    assert.ok(!/blocked/i.test(notice), "a null handle is not called a blocked popup");
}

function testFormUrl(): void {
    assert.equal(
        BUG_REPORT_ISSUE_URL,
        "https://github.com/Paepay/tsps/issues/new",
        "files the issue in Paepay/tsps",
    );
    const url = buildIssueUrl("door won't open", "The door won't open", "---\nWorld: w");
    assert.ok(
        url.startsWith(`${BUG_REPORT_ISSUE_URL}?template=bug_report.yml`),
        "selects the issue form",
    );
    assert.ok(url.includes("title=door"), "title comes from the first line");
    // Issue forms ignore `body`; the report goes into the form's own field ids.
    assert.ok(url.includes("description=The%20door"), "description fills its field");
    assert.ok(url.includes("diagnostics="), "diagnostics fill their field");
    assert.ok(!url.includes("&body="), "no body param, which the form ignores");
}

function testUrlCap(): void {
    const diag = `line\n`.repeat(5000);
    const url = buildIssueUrl("a � 🙂 title that is far too long ".repeat(10), "keep my words", diag);
    assert.ok(url.length <= MAX_ISSUE_URL_LENGTH, `url fits 8KB, was ${url.length}`);
    assert.ok(!url.includes("�"), "no half emoji in the shrunk url");
    assert.ok(url.includes(encodeURIComponent("keep my words")), "description survives overflow");
}

function testDiagnosticsAllowlist(): void {
    const section = formatDiagnosticsSection(baseDiagnostics());
    for (const want of [
        "Zezima",
        "3200, 3200, 0",
        "region 12850",
        "tick 1234",
        "websocket, members",
        "WebGL",
        "50 fps",
        "[warn] something creaked",
        "Attack 99",
        "Coins x1000",
        "Abyssal whip",
        "Welcome to tsps.",
    ]) {
        assert.ok(section.includes(want), `section carries ${want}`);
    }
    for (const banned of ["userAgent", "language", "timeZone", "192.168"]) {
        assert.ok(!section.toLowerCase().includes(banned.toLowerCase()), `section has no ${banned}`);
    }
    // Errors survive the shrink: bulky sections after them are cut first.
    const huge = buildIssueUrl("t", "d", `${"x".repeat(100)}\nRecent errors:\n\`\`\`\n[error] keep me\n\`\`\`\n${"item, ".repeat(5000)}`);
    assert.ok(huge.includes(encodeURIComponent("[error] keep me")), "errors survive overflow");
}

function testEmptyVsUnavailable(): void {
    // Empty-but-logged-in reads as empty, not missing; logged-out skips account state.
    const empty = formatDiagnosticsSection({ ...baseDiagnostics(), inventory: "", equipment: "" });
    assert.ok(empty.includes("Inventory: (empty)"), "empty inventory is explicit");
    assert.ok(empty.includes("Equipment: (empty)"), "empty equipment is explicit");
    const failed = formatDiagnosticsSection({
        ...baseDiagnostics(),
        inventory: undefined,
        skills: undefined,
    });
    assert.ok(failed.includes("Inventory: (unavailable)"), "failed read is not empty");
    assert.ok(failed.includes("Skills: (unavailable)"), "failed read is not empty");
    const loggedOut = formatDiagnosticsSection({
        ...baseDiagnostics(),
        loggedIn: false,
        player: "(logged out)",
        position: undefined,
        skills: undefined,
        inventory: undefined,
        equipment: undefined,
        varps: undefined,
        interfaces: undefined,
        messages: [],
    });
    assert.ok(!loggedOut.includes("Inventory:"), "logged out skips account state");
    assert.ok(loggedOut.includes("Logged out"), "logged out says so");
}

function testErrorLines(): void {
    // Level filtering happens in clientDiagnostics; here lines are already warn/error.
    const lines = ["[warn] 192.168.0.1 creaked", `[error] ${"boom ".repeat(100)}`];
    const formatted = formatErrorLines(lines);
    assert.ok(formatted.includes("(address left out)"), "errors are redacted");
    assert.ok(
        Array.from(formatted).length <= 2 * 300 + 1,
        "each line is shortened to its budget",
    );
}

testTruncation();
testRedaction();
testResolvePlayer();
testCoarseBrowser();
testOpenIssueTab();
testResolveCopyFrame();
testFormUrl();
testUrlCap();
testDiagnosticsAllowlist();
testEmptyVsUnavailable();
testErrorLines();
console.log("bug-report-link: all assertions passed");
