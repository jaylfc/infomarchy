import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { daemonOwnerOf, sessionHostsFromEnvironment } from "./collector";
import { daemonAttachCommand } from "./resume-session";

const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");

// Four of eight live cards on gus could not be jumped to, and none of them
// said why. All four were started by a supervisor: no controlling tty, stdout
// a socket or a pipe owned by the parent. There is no window to raise and no
// pane to select, so the fix is not a jump, it is saying so, plus using the
// owner's own attach where one exists.
describe("a supervisor-run agent is named, not silently unclickable", () => {
  test("the owning supervisor is recognised from its command line", () => {
    expect(daemonOwnerOf(["/usr/bin/no-mistakes", "daemon", "run", "--root", "/home/pi/.no-mistakes"]))
      .toMatchObject({ owner: "no-mistakes", attach: "no-mistakes" });
    expect(daemonOwnerOf(["/home/pi/.harness/runtime/node-v22.23.2-linux-x64/bin/node", "/home/pi/.harness/cli"]))
      .toMatchObject({ owner: "harness", attach: "" });
    // An ordinary terminal is not a supervisor.
    expect(daemonOwnerOf(["kitty"])).toBeNull();
    expect(daemonOwnerOf(["/usr/bin/bash", "--posix"])).toBeNull();
    // `no-mistakes` run by hand is not the daemon either.
    expect(daemonOwnerOf(["/usr/bin/no-mistakes", "status"])).toBeNull();
  });

  test("only an owner that ships an attach gets one", () => {
    expect(daemonAttachCommand("no-mistakes", "~/.no-mistakes/worktrees/abc/01M44"))
      .toEqual(["uwsm-app", "--", "xdg-terminal-exec", "--dir=/home/pi/.no-mistakes/worktrees/abc/01M44", "no-mistakes", "attach"]);
    // harness has no per-agent attach: only `harness tui` and `harness search`,
    // neither of which lands on one agent. Inventing a jump would be worse
    // than the card saying it has none.
    expect(daemonAttachCommand("harness", "~/.harness/cli/data/summary-scratch")).toBeNull();
    expect(daemonAttachCommand("", "~/x")).toBeNull();
    expect(daemonAttachCommand("no-mistakes", "")).toBeNull();
  });

  test("the desk only attaches for the owner that supports it", () => {
    const attach = model.match(/function attachDaemonRun\(host, session\)[\s\S]*?\n  \}/)![0];
    expect(attach).toContain('if (owner !== "no-mistakes") return false');
    expect(attach).toContain('"daemon-attach"');
    expect(attach).toContain("canOpenProject(cwd)");
  });

  test("every card states what a click will do, including when it can do nothing", () => {
    const hint = view.match(/function jumpHint\(item\)[\s\S]*?\n  \}/)![0];
    expect(hint).toContain("click jumps to the pane");
    expect(hint).toContain("click opens its Orca tab");
    expect(hint).toContain("click opens its Herdr pane");
    expect(hint).toContain("click attaches a terminal");
    // The honest ending. This is the line the four dead cards were missing.
    expect(hint).toContain("no terminal to jump to");
    // The hint has to be what the card actually renders.
    expect(view).toContain('text: "hosted in " + view.sessionHostLabel(sc.modelData) + view.jumpHint(sc.modelData)');
  });

  test("a daemon host never pretends to be a terminal", () => {
    // sessionHostsFromEnvironment only reports terminals the agent really is
    // in; the daemon host is added from the process ancestry instead, so an
    // agent with no terminal variables produces no host here at all.
    expect(sessionHostsFromEnvironment("")).toEqual([]);
  });
});

describe("the terminal sort groups the desk without losing a card", () => {
  test("sortedSessions keeps every card and only changes the order", () => {
    const sorted = view.match(/readonly property var sortedSessions: \{[\s\S]*?\n  \}/)![0];
    // Recency order is untouched unless the mode is asked for.
    expect(sorted).toContain('if (settings.sessionSort !== "terminal") return visibleSessions');
    // Concat, not filter: nothing is dropped, which is the point of "keep all
    // the cards where they are".
    expect(sorted).toContain("return reachable.concat(workers)");
    expect(sorted).not.toContain("slice(");
  });

  test("the sort and the click agree, because both ask sessionReachable", () => {
    const reach = view.match(/function sessionReachable\(item\)[\s\S]*?\n  \}/)![0];
    for (const kind of ["orca", "herdr", "boomux", "background", "daemon"]) expect(reach).toContain(kind);
    const sorted = view.match(/readonly property var sortedSessions: \{[\s\S]*?\n  \}/)![0];
    expect(sorted).toContain("sessionReachable(");
    // A disagreement here is the bug this whole group of changes is about: a
    // card sorted as clickable that ignores clicks.
    const hint = view.match(/function jumpHint\(item\)[\s\S]*?\n  \}/)![0];
    expect(hint).toContain("no terminal to jump to");
  });

  test("each card is labelled, and only in the mode where the label means something", () => {
    const chip = view.slice(view.indexOf('readonly property bool reachable: view.sessionReachable(sc.modelData)'));
    expect(chip).toContain('visible: view.settings.sessionSort === "terminal"');
    expect(chip).toContain('text: reachable ? "TERMINAL" : "WORKER BEE"');
  });

  test("the mode is persisted as an enum and reachable over IPC", () => {
    const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
    const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
    const state = readFileSync(join(import.meta.dir, "dashboard-state.ts"), "utf8");
    expect(settings).toContain('property string sessionSort: "recent"');
    expect(settings).toContain('readonly property var sessionSorts: ["recent", "terminal"]');
    expect(settings).toContain("persist({ sessionSort: sessionSort })");
    expect(service).toContain("function setSessionSort(v: string): string");
    expect(service).toContain("function toggleSessionSort(): void");
    // The patch writer validates it as an enum, so an unknown mode cannot be
    // persisted into a sort the desk has no ordering for.
    expect(state).toContain('if (key === "sessionSort") return value === "recent" || value === "terminal";');
  });
});
