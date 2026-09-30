import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LEGACY_NOTICE } from "./web-server";

// The desk rule: every settings control is visible at 1600x1000 logical with
// no page scrolling, lists excepted. This measures InfoView's own SETTINGS
// panel, extracted from InfoView.qml at test time, with the real SettingsBody
// and InfoSettings inside it and Omarchy's Style tokens at base-size 12 and 16.
// It fails if the drawer would need its scrollbar. The token and CIDR lists
// scroll inside their own bounded boxes, so they never push the page. The
// one-time notice for replaced pre-release viewer links is shown in every case.
const root = mkdtempSync(join(tmpdir(), "infomarchy-drawer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");

function block(src: string, start: number): string {
  if (start < 0) return "";
  let depth = 0;
  for (let i = src.indexOf("{", start); i >= 0 && i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

const PANEL_START = "  Rectangle {\n    id: settingsPanel";
const panel = block(view, view.indexOf(PANEL_START));
const tag = block(view, view.indexOf("  component Tag: Rectangle {"));
const plainText = view.match(/^ {2}component PlainText: .*\n/m)?.[0] || "";
const viewProp = (name: string) => view.match(new RegExp(`^ {2}readonly property \\w+ ${name}: .*\\n`, "m"))?.[0] || "";
const viewProps = ["pad", "gap", "radius", "mono"].map(viewProp).join("");

test("the SETTINGS panel is extracted from InfoView, not copied", () => {
  expect(view.split(PANEL_START).length).toBe(2);
  expect(panel).toContain("SettingsBody {");
  expect(panel).toContain("id: settingsFlick");
  expect(panel).toContain("id: settingsHeader");
  expect(tag).toContain("component Tag: Rectangle");
  expect(plainText).toContain("component PlainText");
  for (const name of ["pad", "gap", "radius", "mono"]) expect(viewProp(name)).toContain(" " + name + ": ");
});

function harness(fontScale: number): string {
  const dir = mkdtempSync(join(root, "h-"));
  mkdirSync(join(dir, "Commons"));
  for (const f of ["InfoSettings.qml", "SettingsBody.qml", "dashboard-state.ts", "state-lock.ts", "collector.ts"]) symlinkSync(join(import.meta.dir, f), join(dir, f));
  writeFileSync(join(dir, "Commons/qmldir"), "module qs.Commons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\nsingleton Util 1.0 Util.qml\n");
  writeFileSync(join(dir, "Commons/Color.qml"), 'pragma Singleton\nimport QtQuick\nQtObject { property color foreground: "#dddddd"; property color accent: "#88bbff"; property color urgent: "#ff6666" }\n');
  writeFileSync(join(dir, "Commons/Util.qml"), "pragma Singleton\nimport QtQuick\nQtObject { function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) } }\n");
  // Omarchy's defaults (/usr/share/omarchy/shell/Commons/Style.qml): spacing
  // and font tokens scale with base-size / 12 and round to whole pixels.
  writeFileSync(join(dir, "Commons/Style.qml"), `pragma Singleton
import QtQuick
QtObject {
  readonly property real fontScale: ${fontScale}
  function s(v) { return Math.max(1, Math.round(v * fontScale)) }
  property var spacing: ({ xxs: s(2), xs: s(3), sm: s(4), md: s(6), lg: s(8), xl: s(10) })
  property var font: ({ caption: s(10), bodySmall: s(11), body: s(12), subtitle: s(13) })
  property string resolvedFontFamily: "monospace"
  property int cornerRadius: 0
}
`);
  writeFileSync(join(dir, "web-server.ts"), `
    const cmd = process.argv[2];
    if (cmd === "tokens") console.log(JSON.stringify({ok:true,tokens:Array.from({length:8},(_, i)=>({id:"0000000"+i,label:"viewer-"+i,createdAt:1,suffix:"ab"+i})),extraCidrs:Array.from({length:8},(_, i)=>"10."+i+".0.0/24"),defaults:["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],listening:true,notice:${JSON.stringify(LEGACY_NOTICE)}}));
    else if (cmd === "status") console.log(JSON.stringify({ok:true,running:true,ready:true,message:""}));
    else if (cmd === "qr") console.log(JSON.stringify({ok:true,size:41,rows:Array.from({length:41},()=>"10".repeat(20)+"1")}));
    else console.log(JSON.stringify({ok:false}));
  `);
  writeFileSync(join(dir, "web-tailscale.ts"), 'console.log(JSON.stringify({ok:false,message:"Tailscale is installed but not connected. Connect it, then check again. A longer message wraps onto a second line here."}))');
  writeFileSync(join(dir, "shell.qml"), `import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
ShellRoot {
  InfoSettings { id: settingsObj }
  Window {
    visible: true; width: 1600; height: 1000
    Item {
      id: view
      anchors.fill: parent
      property var settings: settingsObj
      property QtObject desk: QtObject { property color themeBackground: "#101418"; property color themeForeground: "#dddddd" }
      property bool settingsOpen: true
      property bool interactive: true
${viewProps}${plainText}${tag}
${panel}
    }
  }
  Timer { interval: 700; running: true; onTriggered: {
    settingsObj.webAccessMode = Quickshell.env("MODE")
    settingsObj.webEnabled = true; settingsObj.webReady = true; settingsObj.webStarting = false
    settingsBody.refreshQr(); settle.start()
  } }
  Timer { id: settle; interval: 1200; onTriggered: {
    console.log("FIT " + JSON.stringify({ tokens: settingsBody.tokens.length, cidrs: settingsBody.extraCidrs.length, qr: settingsBody.qrSize, notice: settingsBody.statusText,
      content: settingsBody.implicitHeight, viewport: settingsFlick.height, panel: settingsPanel.height, cap: view.height - view.gap * 4 }))
    Qt.quit()
  } }
}
`);
  return dir;
}

for (const baseSize of [12, 16]) for (const mode of ["tailscale", "manual"]) test.skipIf(!existsSync("/usr/bin/quickshell"))(`base-size ${baseSize}, ${mode}: WEB on, QR and notice shown, 8 tokens and 8 CIDRs fit 1600x1000 without scrolling`, async () => {
  const dir = harness(baseSize / 12);
  const state = mkdtempSync(join(root, "s-"));
  const p = Bun.spawn(["/usr/bin/quickshell", "--no-color", "-p", dir], {
    env: { ...process.env, XDG_STATE_HOME: state, QT_QPA_PLATFORM: "offscreen", MODE: mode }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 12000);
  try {
    const output = (await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])).join("\n");
    expect(await p.exited).toBe(0);
    expect(output).not.toMatch(/ReferenceError|TypeError/);
    const line = output.split("\n").find(l => l.includes("FIT {"));
    expect(line).toBeTruthy();
    const fit = JSON.parse(line!.slice(line!.indexOf("FIT ") + 4));
    console.log(`drawer base-size ${baseSize} ${mode}: ${JSON.stringify({ ...fit, notice: !!fit.notice })}`);
    expect(fit).toMatchObject({ tokens: 8, qr: 41, notice: LEGACY_NOTICE });
    if (mode === "manual") expect(fit.cidrs).toBe(8);
    // The panel stays under its cap (the window less four gaps), and the body
    // fits its viewport, so the drawer never shows a scrollbar.
    expect(fit.cap).toBe(1000 - Math.round(8 * baseSize / 12) * 4);
    expect(fit.panel).toBeLessThan(fit.cap);
    expect(fit.content).toBeLessThanOrEqual(fit.viewport);
  } finally { clearTimeout(timer); p.kill("SIGKILL"); await p.exited; }
}, 15000);
