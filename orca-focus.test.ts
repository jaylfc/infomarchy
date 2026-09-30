import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { orcaSwitchArgv, switchToOrcaTerminal, validOrcaHandle } from "./orca-focus";
import { sessionHostsFromEnvironment } from "./collector";

const environ = (pairs: Record<string, string>) => Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\0") + "\0";

describe("Orca terminal handles", () => {
  test("only Orca's own handle shape is accepted", () => {
    expect(validOrcaHandle("term_68dcb0de-301f-4633-9458-dcb5bad5978e")).toBe("term_68dcb0de-301f-4633-9458-dcb5bad5978e");
    for (const bad of ["", "term_", "68dcb0de-301f-4633-9458-dcb5bad5978e", "term_zzzzzzzz-301f-4633-9458-dcb5bad5978e",
      "term_68dcb0de-301f-4633-9458-dcb5bad5978e extra", "term_68dcb0de-301f-4633-9458-dcb5bad5978e;reboot", "$(id)"])
      expect(validOrcaHandle(bad)).toBe("");
  });

  test("the handle becomes argv, never a shell string", () => {
    expect(orcaSwitchArgv("term_68dcb0de-301f-4633-9458-dcb5bad5978e"))
      .toEqual(["orca", "terminal", "switch", "--terminal", "term_68dcb0de-301f-4633-9458-dcb5bad5978e"]);
    expect(orcaSwitchArgv("; rm -rf /")).toEqual([]);
    expect(orcaSwitchArgv("")).toEqual([]);
  });

  test("a rejected handle never spawns anything", async () => {
    // `false` would exit 0 and make a broken handle look like a successful
    // jump; the guard has to refuse before the spawn, not after it.
    expect(await switchToOrcaTerminal("not-a-handle", 1000, "false")).toBe(false);
    expect(await switchToOrcaTerminal("term_68dcb0de-301f-4633-9458-dcb5bad5978e", 1000, "false")).toBe(false);
    expect(await switchToOrcaTerminal("term_68dcb0de-301f-4633-9458-dcb5bad5978e", 1000, "true")).toBe(true);
  });
});

describe("an Orca-hosted agent resolves to its Orca tab", () => {
  // The real shape, taken from /proc on this desk: Orca was launched from a
  // Herdr pane, so its agents inherit HERDR_ENV and HERDR_PANE_ID too.
  const orcaInsideHerdr = environ({
    TERM_PROGRAM: "Orca",
    ORCA_TERMINAL_HANDLE: "term_68dcb0de-301f-4633-9458-dcb5bad5978e",
    ORCA_WORKTREE_ID: "aa9e349c-fceb-4836-954b-ebc439514df8::/home/pi/Projects/autonomous.lamp",
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w30:p1",
    HERDR_SOCKET_PATH: "/home/pi/.config/herdr/herdr.sock",
  });

  test("the inherited Herdr pane is dropped, because it is the pane Orca itself was launched from", () => {
    // Six unrelated Orca agents carried the identical w30:p1 on 2026-09-30, so
    // every card jumped to that one pane. Trusting an inherited id fails
    // silently: the pane is real and live, just not the agent's.
    const hosts = sessionHostsFromEnvironment(orcaInsideHerdr);
    expect(hosts.map(h => h.kind)).toEqual(["orca"]);
    expect(hosts[0].handle).toBe("term_68dcb0de-301f-4633-9458-dcb5bad5978e");
    expect(hosts[0].worktree).toBe("/home/pi/Projects/autonomous.lamp");
    expect(hosts[0].label).toBe("Orca / autonomous.lamp");
  });

  test("a real Herdr agent is untouched", () => {
    const hosts = sessionHostsFromEnvironment(environ({ TERM_PROGRAM: "herdr", HERDR_ENV: "1", HERDR_PANE_ID: "w3Y:p1", HERDR_TAB_ID: "w3Y:t1" }));
    expect(hosts.map(h => h.kind)).toEqual(["herdr"]);
    expect(hosts[0].paneId).toBe("w3Y:p1");
  });

  test("tmux inside an Orca tab survives, because that pane is the agent's own", () => {
    const hosts = sessionHostsFromEnvironment(environ({
      ORCA_TERMINAL_HANDLE: "term_68dcb0de-301f-4633-9458-dcb5bad5978e",
      TMUX: "/tmp/tmux-1000/default,123,0",
      TMUX_PANE: "%7",
    }));
    expect(hosts.map(h => h.kind)).toEqual(["orca", "tmux"]);
    expect(hosts[1].paneId).toBe("%7");
  });

  test("a malformed handle produces no Orca host at all", () => {
    const hosts = sessionHostsFromEnvironment(environ({ ORCA_TERMINAL_HANDLE: "term_bogus", HERDR_ENV: "1", HERDR_PANE_ID: "w3Y:p1" }));
    expect(hosts.map(h => h.kind)).toEqual(["herdr"]);
  });
});

describe("the desk clicks through to Orca", () => {
  const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");

  test("an Orca session jumps by handle, and is tried before every other host", () => {
    const focus = model.match(/function focusOrcaTerminal\(host\)[\s\S]*?\n  \}/)?.[0];
    expect(focus, "InfoModel must expose focusOrcaTerminal").toBeTruthy();
    expect(focus).toContain("root.orcaFocusPath");
    expect(focus).toContain("term_[0-9a-fA-F]{8}");
    // Orca agents have no window of their own: the window belongs to Orca and
    // the agent is a tab inside it, so the no-window branch has to handle them.
    const session = model.match(/function focusSession\(session\)[\s\S]*?\n  \}/)![0];
    expect(session.indexOf('host.kind === "orca"')).toBeLessThan(session.indexOf('host.kind === "boomux"'));
    expect(session).toContain('else if (host.kind === "orca") focusOrcaTerminal(host)');
  });
});

describe("a daemon-hosted session does not borrow the launcher's terminal", () => {
  const collector = readFileSync(join(import.meta.dir, "collector.ts"), "utf8");

  test("background strips the inherited multiplexer hosts, and keeps its own", () => {
    // Measured on this desk: a background Claude session and the interactive
    // one in the same repo both claimed Herdr pane w3T:p1, so the desk showed
    // what read as a duplicate card whose click jumped to the other session.
    const block = collector.match(/if \(hosts\.some\(host => host\.kind === "background"\)\)[\s\S]*?splice\(i, 1\);/)?.[0];
    expect(block, "collector must drop borrowed hosts from a background session").toBeTruthy();
    expect(block).toContain('"orca"');
    expect(block).toContain('"herdr"');
    expect(block).toContain('"boomux"');
    // The background host itself must survive: it is what knows how to attach.
    const splice = block!.slice(block!.indexOf("for (let i"));
    expect(splice).not.toContain('"background"');
    expect(splice).not.toContain('"tmux"');
  });
});
