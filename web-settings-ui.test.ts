import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");

describe("web mode desk controls", () => {
  test("privacy loads only from a saved literal true", () => {
    expect(settings).toContain("privacyMode = !!(parsed && parsed.privacyMode === true)");
  });

  test("the strip and IPC expose WEB and SETTINGS", () => {
    expect(service).toContain("function toggleWeb(): void { dashboardSettings.toggleWebChecked() }");
    expect(view).toContain('text: view.settings.webEnabled ? (view.settings.webReady ? "WEB ON" : (view.settings.webStarting ? "WEB …" : "WEB FAILED")) : "WEB"');
    expect(view).toContain('text: "SETTINGS"');
    expect(view).not.toContain("PHONE");
    expect(view).toContain("SettingsBody");
    expect(view).not.toContain("visible: view.keyboardAvailable && view.settings.webEnabled && !!view.settings.webUrl");
  });

  test("settings read web status and per-section web visibility", () => {
    expect(settings).toContain('command: ["bun", root.webServerPath, "status"]');
    expect(settings).toContain("function refreshWebStatus()");
    expect(settings).toContain("function webSectionEnabled(id)");
  });
});

describe("WEB turns on only through the setup gate", () => {
  test("the strip chip opens SETTINGS when off and IPC uses the checked path", () => {
    const chip = view.slice(view.indexOf('text: view.settings.webEnabled ? (view.settings.webReady ? "WEB ON"'));
    const click = chip.slice(0, chip.indexOf("\n        }"));
    expect(click).toContain("if (view.settings.webEnabled) view.settings.setWebEnabled(false); else view.settingsOpen = true");
    expect(click).not.toContain("toggleWebEnabled");
    expect(service).not.toContain("toggleWebEnabled");
  });

  const cases = [
    { name: "no mode", saved: {}, check: { ok: true }, on: false, message: "Choose an access mode" },
    { name: "tailscale failing", saved: { webAccessMode: "tailscale" }, check: { ok: false, message: "Install Tailscale first." }, on: false, message: "Install Tailscale first." },
    { name: "manual failing", saved: { webAccessMode: "manual" }, check: { ok: false, message: "Certificate fingerprint does not match." }, on: false, message: "fingerprint" },
    { name: "tailscale passing", saved: { webAccessMode: "tailscale" }, check: { ok: true, message: "" }, on: true, message: "" },
  ];
  for (const c of cases) test.skipIf(!existsSync("/usr/bin/quickshell"))("actual QML IPC enable: " + c.name, async () => {
    const dir = mkdtempSync(join(tmpdir(), "infomarchy-webgate-"));
    try {
      mkdirSync(join(dir, "infomarchy"));
      writeFileSync(join(dir, "infomarchy/dashboard.json"), JSON.stringify({ privacyMode: false, webEnabled: false, ...c.saved }));
      writeFileSync(join(dir, "InfoSettings.qml"), settings);
      symlinkSync(join(import.meta.dir, "dashboard-state.ts"), join(dir, "dashboard-state.ts"));
      writeFileSync(join(dir, "web-server.ts"), 'console.log(JSON.stringify({ok:true,running:true,ready:false}));');
      for (const helper of ["web-tailscale.ts", "web-manual.ts"]) writeFileSync(join(dir, helper), `console.log(${JSON.stringify(JSON.stringify(c.check))});`);
      writeFileSync(join(dir, "shell.qml"), `import QtQuick\nimport Quickshell\nShellRoot { InfoSettings {id:s} Timer {property int stage:0;interval:50;running:true;repeat:true;onTriggered:{
        if(stage===0 && s.ready) {stage=1;s.toggleWebChecked()}
        else if(stage>=1 && stage<40) stage++
        else if(stage===40) {console.log("RESULT " + JSON.stringify({on:s.webEnabled,message:s.webStatusText}));Qt.quit()}
      }} }`);
      const p = Bun.spawn(["/usr/bin/quickshell", "--no-color", "-p", dir], { env: { ...process.env, XDG_STATE_HOME: dir, QT_QPA_PLATFORM: "offscreen" }, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill("SIGKILL"), 8000);
      try {
        const output = (await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])).join("\n");
        expect(await p.exited).toBe(0);
        const line = output.split("\n").find(l => l.includes("RESULT {"));
        expect(line).toBeTruthy();
        const result = JSON.parse(line!.slice(line!.indexOf("RESULT ") + 7));
        expect(result.on).toBe(c.on);
        if (c.message) expect(result.message).toContain(c.message);
        const disk = JSON.parse(readFileSync(join(dir, "infomarchy/dashboard.json"), "utf8"));
        expect(disk.webEnabled === true).toBe(c.on);
      } finally { clearTimeout(timer); p.kill("SIGKILL"); await p.exited; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 12000);
});

test("desk helpers run bun from PATH like the rest of the plugin", () => {
  // A hard-coded /usr/bin/bun stops every settings save where Bun lives in
  // ~/.bun/bin or under mise, while the collector keeps working.
  for (const name of ["InfoSettings.qml", "SettingsBody.qml", "Infomarchy.qml", "InfoView.qml"]) {
    expect(readFileSync(join(import.meta.dir, name), "utf8")).not.toContain("/usr/bin/bun");
  }
  expect(settings).toContain('command: ["bun", Qt.resolvedUrl("dashboard-state.ts")');
});

test("only sections the browser renders get a WEB toggle", async () => {
  const { WEB_SECTION_IDS } = await import("./web-page");
  const ids = JSON.parse(settings.match(/readonly property var webSectionIds: (\[[^\]]*\])/)![1]);
  expect(ids).toEqual([...WEB_SECTION_IDS]);
  const body = readFileSync(join(import.meta.dir, "SettingsBody.qml"), "utf8");
  expect(body).toContain("readonly property bool webable: root.settings.webSectionIds.indexOf(modelData.id) >= 0");
  expect(body).toContain('text: !sectionRow.webable ? "WEB n/a"');
  const source = settings.match(/function webSectionEnabled\([\s\S]*?\n  \}/)![0];
  const enabled = Function("webSectionIds", "webSections", "sectionEnabled", `return (${source})`)(ids, {}, () => true);
  for (const id of ["apps", "containers", "fleet", "gitea", "media"]) expect(enabled(id)).toBe(false);
  expect(enabled("usage")).toBe(true);
});
