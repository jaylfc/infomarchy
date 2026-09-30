import { describe, expect, test } from "bun:test";
import { filterWebSnapshot, LIVE_SCRIPT, parseDashPrefs } from "./web-page";
import { copyWebLink, handleRequest, parseCidrList, parsePrefsPatch, SECURITY_HEADERS } from "./web-server";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assessTailscale, boundedCommand, portOccupied, tailOrigin } from "./web-tailscale";

const token = "a".repeat(48);
const snapshot = {
  user: "PRIVATE_USER", host: "PRIVATE_HOST",
  media: { title: "PRIVATE_MEDIA" },
  machine: { externalIp: "PRIVATE_WAN", net: { addr: "PRIVATE_LAN", ssid: "PRIVATE_SSID", wireless: true }, disks: [{ mount: "/home/PRIVATE_USER/work", pct: 3 }] },
  ai: {
    github: { login: "PRIVATE_LOGIN" },
    recent: [{ text: "one two three four PRIVATE_PROMPT", project: "/home/PRIVATE_USER/repo" }, { text: "short prompt" }],
    sessions: [{ provider: "claude", project: "repo", topic: "PRIVATE_TOPIC", cwd: "PRIVATE_CWD", prompt: "PRIVATE_PROMPT", preview: "PRIVATE_PREVIEW" }],
    attention: [{ project: "repo", topic: "PRIVATE_ATTENTION_TOPIC", attention: "waiting", attentionReason: "needs approval", attentionDetail: "PRIVATE_DETAIL", cwd: "PRIVATE_CWD" }],
    usage: { claude: { ready: true, name: "Claude", secret: "PRIVATE_USAGE_EXTRA", limits: [{ label: "week", percent: 0.1, secret: "PRIVATE_LIMIT_EXTRA" }] } },
  },
};
// Private HTTPS shape: Serve connects from loopback with the tailnet Host.
const base = {
  method: "GET", pathname: `/t/${token}/`, host: "desk.example.ts.net:8788", origin: null,
  sourceIp: "127.0.0.1", contentLength: 0, tokens: [{ id: "aaaaaaaa", token, label: "test", createdAt: 1 }],
  cidrs: parseCidrList([]), snapshot, background: null, externalOrigin: "https://desk.example.ts.net:8788",
};

describe("desktop disclosure boundary", () => {
  test("all response bytes omit private sentinels and leave the desktop source intact", () => {
    const before = JSON.stringify(snapshot);
    // Only a saved literal true masks; the desk reads the same file the same way.
    for (const prefs of [parseDashPrefs({}), parseDashPrefs(null), parseDashPrefs({ privacyMode: "true" }), parseDashPrefs({ privacyMode: 1 })]) expect(prefs.privacyMode).toBe(false);
    for (const prefs of [parseDashPrefs({ privacyMode: true })]) {
      for (const pathname of [base.pathname, base.pathname + "snapshot.json"]) {
        const r = handleRequest({ ...base, pathname, prefs });
        expect(r.status).toBe(200);
        expect(String(r.body).includes("PRIVATE_")).toBe(false);
        // The session topic is prompt keywords: dropped under privacy, as on the desk.
        expect(String(r.body).includes("TOPIC")).toBe(false);
        expect(r.headers["Cache-Control"]).toBe("no-store");
        expect(handleRequest({ ...base, pathname, prefs, method: "HEAD" }).body).toBe("");
      }
      const html = String(handleRequest({ ...base, prefs }).body);
      expect(html).toContain("one two three four ···");
      expect(html).toContain("short prompt");
      expect(html).toContain("DISK ~/work");
      expect(html).not.toContain('class="open"');
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(LIVE_SCRIPT).not.toContain("im-privacy");
    expect(parsePrefsPatch('{"privacyMode":false}')).toBeNull();
  });
  test("privacy off discloses permitted values but keeps exclusions", () => {
    const html = String(handleRequest({ ...base, prefs: parseDashPrefs({ privacyMode: false }) }).body);
    for (const marker of ["PRIVATE_USER", "PRIVATE_HOST", "PRIVATE_WAN", "PRIVATE_LAN", "PRIVATE_SSID", "PRIVATE_PROMPT"])
      expect(html.includes(marker)).toBe(true);
    for (const marker of ["PRIVATE_LOGIN", "PRIVATE_MEDIA", "PRIVATE_CWD", "PRIVATE_PREVIEW", "PRIVATE_DETAIL"])
      expect(html.includes(marker)).toBe(false);
    // With privacy off the topic is sent, in the page and in both JSON row kinds.
    expect(html).toContain("PRIVATE_TOPIC");
    const json = String(handleRequest({ ...base, pathname: base.pathname + "snapshot.json", prefs: parseDashPrefs({ privacyMode: false }) }).body);
    expect(json).toContain("PRIVATE_TOPIC");
    expect(json).toContain("PRIVATE_ATTENTION_TOPIC");
    const view = filterWebSnapshot(snapshot, false);
    expect(view.ai.recent[0].text).toContain("PRIVATE_PROMPT");
    expect(view.ai.sessions[0].cwd).toBeUndefined();
  });
});

describe("private HTTPS boundary", () => {
  const origin = "https://desk.example.ts.net:8788";
  const proxied = { ...base, externalOrigin: origin, host: "desk.example.ts.net:8788", prefs: parseDashPrefs({}) };
  test("accepts the explicit HTTPS Host through loopback, with token authorization", () => {
    expect(handleRequest(proxied).status).toBe(200);
    expect(handleRequest({ ...proxied, origin }).status).toBe(200);
    expect(handleRequest({ ...proxied, pathname: "/t/" + "b".repeat(48) + "/" }).status).toBe(404);
    for (const sourceIp of ["100.100.1.2", "192.168.1.2", "8.8.8.8"])
      expect(handleRequest({ ...proxied, sourceIp }).status).toBe(403);
    for (const host of ["127.0.0.1:8787", "evil.ts.net:8788", "desk.example.ts.net", "desk.example.ts.net:443"])
      expect(handleRequest({ ...proxied, host }).status).toBe(403);
    for (const bad of ["http://desk.example.ts.net:8788", "https://evil.ts.net:8788", origin + "/", "null"])
      expect(handleRequest({ ...proxied, origin: bad }).status).toBe(403);
    expect(handleRequest({ ...proxied, externalOrigin: "https://evil.example:8788" }).status).toBe(403);
    expect(handleRequest({ ...proxied, method: "POST", pathname: base.pathname + "prefs", contentType: "application/json", body: "{}" }).status).toBe(403);
  });
  test("a request without an HTTPS origin is refused, so no plain HTTP path exists", () => {
    for (const externalOrigin of [undefined, "", "http://desk.example.ts.net:8788", "http://192.168.1.20:8787"]) {
      expect(handleRequest({ ...base, externalOrigin }).status).toBe(403);
      expect(handleRequest({ ...base, externalOrigin, host: "192.168.1.20:8787", sourceIp: "192.168.1.60" }).status).toBe(403);
    }
    expect(tailOrigin("desk.example.ts.net.")).toBe(origin);
    for (const name of ["evil.example", "desk.ts.net.evil.example", "-bad.ts.net", "desk.ts.net/path", "desk.ts.net@evil"])
      expect(tailOrigin(name)).toBe("");
  });
});

describe("guided Serve setup", () => {
  const running = { BackendState: "Running", Self: { Online: true, DNSName: "desk.example.ts.net." } };
  const help = "--https --bg";
  test("missing, stopped, signed-out and unsupported states give actionable failures", () => {
    expect(assessTailscale(null, {}, help).state).toBe("unavailable");
    expect(assessTailscale({ BackendState: "Stopped" }, {}, help).state).toBe("stopped");
    expect(assessTailscale({ BackendState: "NeedsLogin" }, {}, help).state).toBe("login");
    expect(assessTailscale(running, null, help).state).toBe("config");
    expect(assessTailscale(running, {}, "old cli").state).toBe("version");
    expect(assessTailscale(running, {}, help).ok).toBe(true);
  });
  test("unrelated services survive inspection; conflicts include foreground and Funnel", () => {
    const unrelated = { TCP: { "443": { HTTPS: true } }, Web: { "desk.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3000" } } } } };
    const before = JSON.stringify(unrelated);
    expect(assessTailscale(running, unrelated, help).ok).toBe(true);
    expect(JSON.stringify(unrelated)).toBe(before);
    for (const config of [
      { TCP: { "8788": { HTTPS: true } } },
      { Web: { "desk.example.ts.net:8788": {} } },
      { AllowFunnel: { "desk.example.ts.net:8788": true } },
      { Foreground: { other: { TCP: { "8788": { HTTPS: true } } } } },
    ]) {
      expect(portOccupied(config)).toBe(true);
      expect(assessTailscale(running, config, help).state).toBe("conflict");
    }
  });
  test("CLI output and execution have finite bounds", async () => {
    expect(await boundedCommand(["/usr/bin/printf", "small"], 32)).toBe("small");
    expect(await boundedCommand(["/usr/bin/yes"], 32)).toBeNull();
    expect(await boundedCommand(["/usr/bin/sleep", "10"], 32, 30)).toBeNull();
    expect(await boundedCommand(["/does/not/exist"], 32)).toBeNull();
  });
});

describe("defense in depth", () => {
  test("fields no renderer names never reach a browser, at either privacy setting", () => {
    const extra = structuredClone(snapshot) as any;
    extra.fleet = { hosts: [{ name: "LEAK_FLEET_HOST" }] };
    extra.apps = [{ name: "LEAK_APP", cwd: "/home/x/LEAK_APP_DIR" }];
    extra.containers = [{ name: "LEAK_CONTAINER" }];
    extra.futureTopLevel = "LEAK_TOP";
    extra.ai.gitea = { login: "LEAK_GITEA_LOGIN" };
    extra.ai.hermes = { key: "LEAK_HERMES" };
    extra.ai.futureAi = "LEAK_AI";
    extra.ai.usage.claude.billing = { window: "LEAK_BILLING" };
    extra.ai.usage.claude.tint = "LEAK_TINT";
    extra.ai.projects = [{ project: "repo", path: "/home/x/LEAK_PROJECT_PATH", changes: { files: ["/home/x/LEAK_FILE"], commitSubject: "subject" }, git: { branch: "main", remote: "LEAK_REMOTE" } }];
    extra.ai.providers = { ollama: { present: true, up: true, host: "LEAK_OLLAMA_HOST", loaded: [{ name: "qwen3", digest: "LEAK_DIGEST" }], models: [{ name: "qwen3", size: 1, path: "LEAK_MODEL_PATH" }] }, other: { secret: "LEAK_PROVIDER" } };
    // Machine telemetry, the heatmaps and their counts are named field by field too.
    extra.machine = {
      hostname: "LEAK_HOSTNAME", temp: 50, uptime: 60, externalIp: "203.0.113.9",
      cpu: { pct: 12, load: [0.5, 0.4, 0.3], model: "LEAK_CPU_MODEL" },
      mem: { pct: 40, used: 4, total: 10, swapDevice: "LEAK_SWAP" },
      net: { dev: "wlan0", wireless: true, ssid: "home", signal: -50, addr: "192.168.1.9", rxRate: 1, txRate: 2, gateway: "LEAK_GATEWAY" },
      ping: { ok: true, ms: 9, target: "LEAK_PING_TARGET" },
      battery: { pct: 80, status: "Charging", serial: "LEAK_BATTERY_SERIAL" },
      disks: [{ mount: "/", size: 100, used: 50, pct: 50, device: "LEAK_DISK_DEVICE" }],
    };
    extra.ai.heatmap = { cells: [[2, { claude: 2 }], { n: 1, note: "LEAK_CELL" }], days: [1], extra: "LEAK_HEATMAP" };
    extra.ai.counts = { claude: { today: 1, week: 2, extra: "LEAK_COUNTS" } };
    extra.ai.github = { login: "LEAK_GITHUB_LOGIN", cells: [3], days: [1], counts: { pr: { today: 1, week: 1, extra: "LEAK_GITHUB_COUNTS" } } };
    for (const privacyMode of [true, false]) {
      const prefs = parseDashPrefs({ privacyMode });
      for (const pathname of [base.pathname, base.pathname + "snapshot.json"]) {
        const body = String(handleRequest({ ...base, snapshot: extra, pathname, prefs }).body);
        expect(body.match(/LEAK_[A-Z_]+/g)).toBeNull();
      }
      // The filtered view itself holds none of them, so a future renderer cannot leak them either.
      expect(JSON.stringify(filterWebSnapshot(extra, privacyMode)).match(/LEAK_[A-Z_]+/g)).toBeNull();
    }
    const view = filterWebSnapshot(extra, false);
    expect(view.ai.projects[0]).toEqual({ project: "repo", git: { branch: "main" }, changes: { fileCount: 1, commitSubject: "subject" } });
    expect(view.ai.providers.ollama.models[0]).toEqual({ name: "qwen3", size: 1 });
    // Tight enough to leak nothing, loose enough that the MACHINE card keeps every value it shows.
    expect(view.machine).toEqual({
      temp: 50, uptime: 60, externalIp: "203.0.113.9",
      cpu: { pct: 12, load: [0.5, 0.4, 0.3] },
      mem: { pct: 40, used: 4, total: 10 },
      net: { dev: "wlan0", wireless: true, ssid: "home", signal: -50, addr: "192.168.1.9", rxRate: 1, txRate: 2 },
      ping: { ok: true, ms: 9 },
      battery: { pct: 80, status: "Charging" },
      disks: [{ mount: "/", size: 100, used: 50, pct: 50 }],
    });
    expect(view.ai.heatmap).toEqual({ cells: [[2, { claude: 2 }], [1, {}]], days: [1] });
    expect(view.ai.counts).toEqual({ claude: { today: 1, week: 2 } });
    expect(view.ai.github).toEqual({ cells: [[3, {}]], days: [1], counts: { pr: { today: 1, week: 1 } }, login: "" });
  });

  test("every response carries CORP and COOP and no HSTS", () => {
    // HSTS would cover every port on the same host name, and links are always HTTPS.
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBeUndefined();
    expect(SECURITY_HEADERS["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    const replies = [
      handleRequest(base), handleRequest({ ...base, host: "evil.example" }), handleRequest({ ...base, pathname: "/t/" + "b".repeat(48) + "/" }),
      handleRequest({ ...base, snapshot: null }), handleRequest({ ...base, method: "PUT" }),
    ];
    expect(replies.map(r => r.status)).toEqual([200, 403, 404, 503, 405]);
    for (const r of replies) {
      expect(r.headers).not.toHaveProperty("Strict-Transport-Security");
      expect(r.headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
      expect(r.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    }
  });

  test("COPY URL asks the clipboard not to keep the link, and retries plainly on an old wl-copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infomarchy-wlcopy-"));
    try {
      const log = join(dir, "argv");
      for (const [supportsFlag, expected] of [[true, ["--sensitive"]], [false, ["--sensitive", ""]]] as const) {
        const stub = join(dir, "wl-copy-" + supportsFlag);
        writeFileSync(stub, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log + supportsFlag)}\ncat > /dev/null\n${supportsFlag ? "exit 0" : '[ "$1" = "--sensitive" ] && exit 1\nexit 0'}\n`);
        chmodSync(stub, 0o755);
        expect(await copyWebLink("https://desk.example.ts.net:8788/t/" + "a".repeat(48) + "/", stub)).toBe(true);
        expect(readFileSync(log + supportsFlag, "utf8").split("\n").slice(0, -1)).toEqual([...expected]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
