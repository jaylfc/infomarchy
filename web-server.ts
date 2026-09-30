#!/usr/bin/env bun
// Web Mode: HTML of the latest collector snapshot, served only over HTTPS.
// Private HTTPS is a loopback backend behind an owned Tailscale Serve mapping.
// Manual HTTPS serves an existing, fingerprint-pinned certificate directly.
// Off until toggled. Token in the path, exact Host and Origin, source allow
// list for Manual HTTPS, HTML-escaped fields. GET/HEAD for the page. POST
// /prefs for web section visibility and narrow-layout order. The token never
// travels in argv. Plain HTTP on the LAN was removed and is refused.

import { loadManualTls, readManualPrefs, validManualOrigin } from "./web-manual";
import { withStateLock } from "./state-lock";
import { patchDashboard } from "./dashboard-state";
import { randomBytes, timingSafeEqual } from "crypto";
import { isIP } from "net";
import { dirname, join } from "path";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, unlinkSync } from "fs";
import { parseJsonBounded, readRegularFileLimited, writePrivateStateFile } from "./collector";
import { inspectTailscale, startServe, serveMappingReady, tailOrigin } from "./web-tailscale";
import {
  DEFAULT_NARROW_ORDER, FALLBACK_THEME, WEB_SECTION_IDS, filterWebSnapshot, normalizeOrder, parseDashPrefs, parseThemeColors, renderPage,
  type DashPrefs, type ThemeColors,
} from "./web-page";

export {
  displayMount, escapeHtml, fmtBytes, fmtDur, fmtMoney, fmtPct, fmtRate, fmtTokens, fmtUntil,
  providerColorHex, renderMachineSection, renderTrendSvg, renderUsageSection, usageSeriesOf, wifiLabel,
} from "./web-page";

const HOME = process.env.HOME || "/root";
const XDG_STATE = process.env.XDG_STATE_HOME || join(HOME, ".local/state");
const STATE_DIR = join(XDG_STATE, "infomarchy");
const CONFIG_NAME = "web.json";
const SNAPSHOT_NAME = "web-snapshot.json";
const MAX_SNAPSHOT_BYTES = 960 * 1024;
const TOKEN_BYTES = 24;
// Loopback-only backend behind Tailscale Serve. Never bound to a LAN address.
const SERVE_BACKEND_PORT = 8787;
const MAX_REQUEST_BYTES = 8192;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

export const DEFAULT_CIDRS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

export type Cidr = { network: number; mask: number; text: string };

export function ipv4ToInt(ip: string): number | null {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return null;
  const n = parts.map(part => Number(part));
  if (n.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return ((n[0] << 24) >>> 0) + (n[1] << 16) + (n[2] << 8) + n[3];
}

export function parseCidr(text: string): Cidr | null {
  const raw = String(text || "").trim();
  const match = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return null;
  const network = ipv4ToInt(match[1]);
  const bits = Number(match[2]);
  if (network === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: network & mask, mask, text: match[1] + "/" + bits };
}

export function canonicalIp(value: string): string {
  return String(value || "").trim().replace(/^::ffff:/i, "");
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const n = ipv4ToInt(canonicalIp(ip));
  return n !== null && (n & cidr.mask) === cidr.network;
}

export function ipAllowed(ip: string, cidrs: Cidr[]): boolean {
  const host = canonicalIp(ip);
  if (isIP(host) !== 4) return false;
  return cidrs.some(cidr => ipInCidr(host, cidr));
}

export function parseCidrList(values: unknown): Cidr[] {
  const extra = Array.isArray(values) ? values : [];
  const out: Cidr[] = [];
  const seen = new Set<string>();
  for (const item of [...DEFAULT_CIDRS, ...extra]) {
    const cidr = parseCidr(String(item || ""));
    if (!cidr || seen.has(cidr.text)) continue;
    seen.add(cidr.text);
    out.push(cidr);
  }
  return out;
}

export function tokensEqual(got: string, expected: string): boolean {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export const MAX_TOKENS = 8;
export const MAX_EXTRA_CIDRS = 8;
const CONFIG_MAX_BYTES = 8192;

export type WebToken = {
  id: string;
  token: string;
  label: string;
  createdAt: number;
};

export type WebConfig = {
  tokens: WebToken[];
  port: number;
  extraCidrs: string[];
  listening: boolean;
  legacyReplaced?: boolean;
};

// Every web.json this build writes carries CONFIG_VERSION. A file without it
// was written by a pre-release build that offered LAN HTTP, so its tokens may
// have crossed the network unencrypted. It is never read as credentials, and
// it is replaced once under web-config.lock (loadOrReplaceLegacyLocked).
const CONFIG_VERSION = 2;
export const LEGACY_NOTICE = "LAN HTTP was removed. Viewer links made before this update were replaced, because they could have crossed the network unencrypted. Share a new link with each viewer.";

export function validToken(value: unknown): string {
  const token = String(value || "");
  return /^[0-9a-f]{48}$/.test(token) ? token : "";
}

export function validTokenId(value: unknown): string {
  const id = String(value || "");
  return /^[0-9a-f]{8}$/.test(id) ? id : "";
}

export function validTokenLabel(value: unknown): string {
  const label = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(label) ? label : "";
}

export function validPort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

export function newTokenId(): string {
  return randomBytes(4).toString("hex");
}

export function makeToken(label = "default"): WebToken {
  return { id: newTokenId(), token: newToken(), label: validTokenLabel(label) || "default", createdAt: Date.now() };
}

export function parseTokens(parsed: Record<string, unknown>): WebToken[] {
  const out: WebToken[] = [];
  const seen = new Set<string>();
  if (Array.isArray(parsed.tokens)) {
    for (const item of parsed.tokens) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const token = validToken(row.token);
      const id = validTokenId(row.id) || newTokenId();
      const label = validTokenLabel(row.label) || "token";
      const createdAt = Number(row.createdAt);
      if (!token || seen.has(token) || seen.has(id)) continue;
      seen.add(token);
      seen.add(id);
      out.push({ id, token, label, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now() });
      if (out.length >= MAX_TOKENS) break;
    }
  }
  const legacy = validToken(parsed.token);
  if (legacy && !seen.has(legacy) && out.length < MAX_TOKENS) {
    out.unshift({ id: newTokenId(), token: legacy, label: "default", createdAt: Date.now() });
  }
  return out;
}

export function publicTokenList(config: WebConfig): { id: string; label: string; createdAt: number; suffix: string }[] {
  return config.tokens.map(row => ({ id: row.id, label: row.label, createdAt: row.createdAt, suffix: row.token.slice(-4) }));
}

export function tokenAllowed(got: string, tokens: WebToken[]): boolean {
  let ok = false;
  for (const row of tokens) {
    if (tokensEqual(got, row.token)) ok = true;
  }
  return ok;
}

// Reads web.json with the descriptor, owner, link-count, mode and size checks.
// A file that fails them is null, and callers never overwrite it.
function readConfigFile(): Record<string, any> | null {
  let raw = "";
  let fd = -1;
  try {
    fd = openSync(join(STATE_DIR, CONFIG_NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size > CONFIG_MAX_BYTES) return null;
    const bytes = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > CONFIG_MAX_BYTES) return null;
    raw = bytes.subarray(0, count).toString("utf8");
  } catch { return null; }
  finally { if (fd >= 0) closeSync(fd); }
  if (!raw) return null;
  const parsed = parseJsonBounded(raw, CONFIG_MAX_BYTES, 12);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function configFrom(parsed: Record<string, any>): WebConfig | null {
  const tokens = parseTokens(parsed);
  const port = validPort(parsed.port) || SERVE_BACKEND_PORT;
  const extraCidrs = Array.isArray(parsed.extraCidrs)
    ? parsed.extraCidrs.map((item: unknown) => String(item)).filter((item: string) => !!parseCidr(item)).slice(0, MAX_EXTRA_CIDRS)
    : [];
  if (!tokens.length) return null;
  return { tokens, port, extraCidrs, listening: parsed.listening !== false, ...(parsed.legacyReplaced === true ? { legacyReplaced: true } : {}) };
}

// Fails closed: a pre-release file is never accepted, revealed or encoded,
// even before anything has replaced it.
export function loadConfig(): WebConfig | null {
  const parsed = readConfigFile();
  return parsed && parsed.version === CONFIG_VERSION ? configFrom(parsed) : null;
}

// Call only while web-config.lock is held. A safe, readable pre-release file
// with at least one token gets one new token per old label, keeps its port
// and allow list, and is saved not listening. Idempotent: the saved file
// carries CONFIG_VERSION. Nothing about the old or new tokens is printed.
function loadOrReplaceLegacyLocked(): WebConfig | null {
  const parsed = readConfigFile();
  if (!parsed) return null;
  if (Object.hasOwn(parsed, "version")) return parsed.version === CONFIG_VERSION ? configFrom(parsed) : null;
  const legacy = configFrom(parsed);
  if (!legacy) return null;
  const replaced: WebConfig = {
    tokens: legacy.tokens.map(row => makeToken(row.label)),
    port: legacy.port,
    extraCidrs: legacy.extraCidrs,
    listening: false,
    legacyReplaced: true,
  };
  if (!saveConfig(replaced)) throw new Error("Cannot replace Web Mode credentials");
  return replaced;
}

function saveConfig(config: WebConfig): boolean {
  return writePrivateStateFile(STATE_DIR, CONFIG_NAME, JSON.stringify({
    version: CONFIG_VERSION,
    tokens: config.tokens,
    port: config.port,
    extraCidrs: config.extraCidrs,
    listening: !!config.listening,
    ...(config.legacyReplaced ? { legacyReplaced: true } : {}),
  }) + "\n");
}

// The notice asks for a new link, so the first link handed out clears it.
// Best effort: a failure here never fails the command that handed it out.
export function clearLegacyNotice(): void {
  try { withStateLock(STATE_DIR, "web-config.lock", () => {
    const config = loadConfig();
    if (!config?.legacyReplaced) return;
    delete config.legacyReplaced;
    saveConfig(config);
  }); } catch {}
}

export function loadConfigForSettings(): WebConfig | null {
  try { return withStateLock(STATE_DIR, "web-config.lock", () => loadOrReplaceLegacyLocked()); }
  catch { return loadConfig(); }
}

export function ensureConfig(extraCidrs: string[] = [], listening?: boolean): WebConfig {
  return withStateLock(STATE_DIR, "web-config.lock", () => ensureConfigLocked(extraCidrs, listening));
}

function ensureConfigLocked(extraCidrs: string[] = [], listening?: boolean): WebConfig {
  const existing = loadOrReplaceLegacyLocked();
  if (existing) {
    let changed = false;
    if (extraCidrs.length) {
      const merged = [...existing.extraCidrs];
      for (const item of extraCidrs) if (parseCidr(item) && !merged.includes(item)) merged.push(item);
      existing.extraCidrs = merged.slice(0, MAX_EXTRA_CIDRS);
      changed = true;
    }
    if (listening !== undefined && existing.listening !== listening) {
      existing.listening = listening;
      changed = true;
    }
    if (changed && !saveConfig(existing)) throw new Error("Cannot save Web Mode settings");
    return existing;
  }
  // A rejected credential file is not permission to overwrite/rotate it.
  try { lstatSync(join(STATE_DIR, CONFIG_NAME)); throw new Error("Cannot read Web Mode credentials"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const created: WebConfig = {
    tokens: [makeToken("default")],
    port: SERVE_BACKEND_PORT,
    extraCidrs: extraCidrs.filter(item => !!parseCidr(item)).slice(0, MAX_EXTRA_CIDRS),
    listening: listening === true,
  };
  if (!saveConfig(created)) throw new Error("Cannot save Web Mode settings");
  return created;
}

export function addWebToken(label: string): WebToken | null {
  try { return withStateLock(STATE_DIR, "web-config.lock", () => {
    const config = ensureConfigLocked();
    if (config.tokens.length >= MAX_TOKENS) return null;
    const token = makeToken(label);
    config.tokens.push(token);
    return saveConfig(config) ? token : null;
  }); } catch { return null; }
}

export type RevokeResult = "revoked" | "not-found" | "last-token" | "unavailable";
export const REVOKE_EXIT: Record<RevokeResult, number> = { revoked: 0, unavailable: 1, "not-found": 2, "last-token": 3 };

// Distinguishes a missing id from the last remaining token, so a caller never
// mistakes a refused revoke for a dead credential. "unavailable" covers an
// unreadable web.json, a busy lock and a failed save.
export function revokeWebToken(id: string): RevokeResult {
  try { return withStateLock(STATE_DIR, "web-config.lock", (): RevokeResult => {
    const config = loadOrReplaceLegacyLocked();
    if (!config) return "unavailable";
    const next = config.tokens.filter(row => row.id !== id);
    if (next.length === config.tokens.length) return "not-found";
    if (!next.length) return "last-token";
    config.tokens = next;
    return saveConfig(config) ? "revoked" : "unavailable";
  }); } catch { return "unavailable"; }
}

export function addExtraCidr(text: string): boolean {
  try { return withStateLock(STATE_DIR, "web-config.lock", () => {
    const cidr = parseCidr(text);
    if (!cidr) return false;
    const config = ensureConfigLocked();
    if (config.extraCidrs.includes(cidr.text)) return true;
    if (config.extraCidrs.length >= MAX_EXTRA_CIDRS) return false;
    config.extraCidrs.push(cidr.text);
    return saveConfig(config);
  }); } catch { return false; }
}

export function removeExtraCidr(text: string): boolean {
  try { return withStateLock(STATE_DIR, "web-config.lock", () => {
    const cidr = parseCidr(text);
    if (!cidr) return false;
    const config = loadOrReplaceLegacyLocked();
    if (!config) return false;
    const next = config.extraCidrs.filter(item => item !== cidr.text);
    if (next.length === config.extraCidrs.length) return false;
    config.extraCidrs = next;
    return saveConfig(config);
  }); } catch { return false; }
}

export const maskSnapshot = filterWebSnapshot;

function take(list: unknown, n: number): any[] {
  return Array.isArray(list) ? list.slice(0, n) : [];
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function contentSecurityPolicy(nonce = ""): string {
  const n = /^[0-9a-f]{32}$/.test(nonce) ? nonce : "";
  const extra = n ? ` script-src 'nonce-${n}'; connect-src 'self';` : "";
  return `default-src 'none'; style-src 'unsafe-inline';${extra} img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
}

const MAX_BG_BYTES = 8 * 1024 * 1024;
const THEME_COLORS_PATH = join(HOME, ".local/state/omarchy/current/theme/colors.toml");
const BACKGROUND_LINK = join(HOME, ".local/state/omarchy/current/background");

export function loadTheme(): ThemeColors {
  const raw = readRegularFileLimited(THEME_COLORS_PATH, 16_384);
  return raw ? parseThemeColors(raw) : FALLBACK_THEME;
}

export function loadDashPrefs(): DashPrefs {
  const raw = readRegularFileLimited(join(STATE_DIR, "dashboard.json"), 256 * 1024);
  if (!raw) return parseDashPrefs({});
  const parsed = parseJsonBounded(raw, 256 * 1024, 16);
  return parseDashPrefs(parsed);
}

export function imageContentType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  return "";
}

export function resolveBackgroundPath(): string {
  try {
    const target = readlinkSync(BACKGROUND_LINK);
    if (!target) return "";
    return target.startsWith("/") ? target : join(dirname(BACKGROUND_LINK), target);
  } catch {
    return "";
  }
}

export function backgroundRevision(): string {
  try {
    const link = lstatSync(BACKGROUND_LINK);
    const m = Math.round(Number(link.mtimeMs) || 0);
    if (!Number.isFinite(m) || m < 0 || m > 1e16) return "";
    let size = 0;
    try {
      const target = resolveBackgroundPath();
      if (target) {
        const st = lstatSync(target);
        if (st.isFile()) size = st.size;
      }
    } catch {}
    if (!Number.isFinite(size) || size < 0 || size > 1e16) size = 0;
    return m + "-" + Math.floor(size);
  } catch {
    return "";
  }
}

export function readBackgroundImage(): { type: string; bytes: Buffer } | null {
  const path = resolveBackgroundPath();
  if (!path || path.length > 512 || path.includes("\0")) return null;
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_BG_BYTES) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, Math.min(64 * 1024, st.size - off), off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== st.size) return null;
    const type = imageContentType(buf);
    return type ? { type, bytes: buf } : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

export function parseAsciiQr(text: string): string[] {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter(line => line.length > 0).slice(0, 80);
  const rows: string[] = [];
  for (const line of lines) {
    let bits = "";
    for (let i = 0; i + 1 < line.length && bits.length < 80; i += 2) bits += line.slice(i, i + 2) === "##" ? "1" : "0";
    if (bits.length) rows.push(bits);
  }
  if (rows.length < 21 || rows.some(row => row.length !== rows[0].length)) return [];
  return rows;
}

export async function qrMatrixForUrl(url: string, executable = "/usr/bin/qrencode"): Promise<string[]> {
  if (!/^https:\/\/[0-9a-zA-Z.:[\]-]+\/t\/[0-9a-f]{48}\/$/.test(url)) return [];
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn([executable, "-t", "ASCII", "-m", "2", "-o", "-"], {
    stdin: new Blob([url]), stdout: "pipe", stderr: "ignore",
  }); } catch { return []; }
  const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of proc.stdout) {
      bytes += chunk.length;
      if (bytes > 16384) return [];
      chunks.push(chunk);
    }
    return await proc.exited === 0 ? parseAsciiQr(Buffer.concat(chunks).toString("utf8")) : [];
  } finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
}

// --sensitive asks clipboard managers not to keep the link in history. A
// wl-copy too old for the flag gets one plain retry rather than no copy.
export async function copyWebLink(url: string, executable = "/usr/bin/wl-copy"): Promise<boolean> {
  for (const args of [["--sensitive"], []]) {
    let proc: ReturnType<typeof Bun.spawn>;
    try { proc = Bun.spawn([executable, ...args], { stdin: new Blob([url]), stdout: "ignore", stderr: "ignore" }); }
    catch { return false; }
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    try { if (await proc.exited === 0) return true; }
    finally { clearTimeout(timer); }
  }
  return false;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // No HSTS: a policy would apply to every port on the same host name, and
  // viewer links are always HTTPS.
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": contentSecurityPolicy(),
};

type Reply = { status: number; headers: Record<string, string>; body: string | Uint8Array };

function reply(status: number, body: string | Uint8Array, type = "text/html; charset=utf-8", nonce = ""): Reply {
  return { status, headers: { ...SECURITY_HEADERS, "Content-Type": type, "Content-Security-Policy": contentSecurityPolicy(nonce) }, body };
}

export function jsonContentType(value: string): boolean {
  return String(value || "").split(";")[0].trim().toLowerCase() === "application/json";
}

export function parsePrefsPatch(raw: string): { webSections?: Record<string, boolean>; webNarrowOrder?: string[] } | null {
  const parsed = parseJsonBounded(raw, 4096, 6);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).some(key => key !== "webSections" && key !== "webNarrowOrder")) return null;
  const out: { webSections?: Record<string, boolean>; webNarrowOrder?: string[] } = {};
  if (parsed.webSections && typeof parsed.webSections === "object" && !Array.isArray(parsed.webSections)) {
    const sections: Record<string, boolean> = Object.create(null);
    for (const id of WEB_SECTION_IDS) {
      if (Object.prototype.hasOwnProperty.call(parsed.webSections, id)) sections[id] = parsed.webSections[id] === true;
    }
    out.webSections = sections;
  }
  if (Array.isArray(parsed.webNarrowOrder)) out.webNarrowOrder = normalizeOrder(parsed.webNarrowOrder, DEFAULT_NARROW_ORDER);
  if (!out.webSections && !out.webNarrowOrder) return null;
  return out;
}

export function patchDashboardPrefs(patch: { webSections?: Record<string, boolean>; webNarrowOrder?: string[] }): boolean {
  return patchDashboard(STATE_DIR, patch);
}

export function handleRequest(input: {
  method: string;
  pathname: string;
  host: string;
  origin: string | null;
  sourceIp: string;
  contentLength: number;
  tokens: WebToken[];
  cidrs: Cidr[];
  snapshot: any | null;
  prefs?: DashPrefs;
  theme?: ThemeColors;
  background?: { type: string; bytes: Buffer } | null;
  body?: string;
  contentType?: string;
  externalOrigin?: string;
  manualTls?: boolean;
}): Reply {
  const method = String(input.method || "").toUpperCase();
  if (input.contentLength > MAX_REQUEST_BYTES) return reply(413, "too large");
  // Every request is judged against an HTTPS origin discovered locally, never
  // from HTTP. Without one there is nothing to serve: no plain HTTP path exists.
  if (!input.externalOrigin) return reply(403, "forbidden");
  let external: URL;
  try { external = new URL(input.externalOrigin); } catch { return reply(403, "forbidden"); }
  // Private HTTPS: the actual TCP peer must be loopback, and forwarded or
  // identity headers confer no authority. Manual HTTPS: the source allow list.
  const reachable = input.manualTls
    ? validManualOrigin(input.externalOrigin) && ipAllowed(input.sourceIp, input.cidrs)
    : tailOrigin(external.hostname) === input.externalOrigin && canonicalIp(input.sourceIp) === "127.0.0.1";
  if (!reachable || input.host.toLowerCase() !== external.host || (input.origin !== null && input.origin !== input.externalOrigin)) return reply(403, "forbidden");
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return reply(405, "method not allowed");

  const path = String(input.pathname || "");
  if (path.length > 256 || path.includes("..") || path.includes("//") || path.includes("\\") || path.includes("%")) return reply(404, "not found");
  const match = path.match(/^\/t\/([0-9a-f]{48})\/(snapshot\.json|bg|prefs)?$/);
  if (!match || !tokenAllowed(match[1], input.tokens || [])) return reply(404, "not found");

  if (method === "POST") {
    if (match[2] !== "prefs") return reply(405, "method not allowed");
    if (!input.origin) return reply(403, "forbidden");
    if (!jsonContentType(input.contentType || "")) return reply(415, "unsupported media type");
    const patch = parsePrefsPatch(input.body || "");
    if (!patch) return reply(400, "bad request");
    if (!patchDashboardPrefs(patch)) return reply(500, "unavailable");
    return reply(200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
  }
  if (match[2] === "prefs") return reply(405, "method not allowed");

  const pagePath = `/t/${match[1]}/`;
  if (match[2] === "bg") {
    const image = input.background === undefined ? readBackgroundImage() : input.background;
    if (!image) return reply(404, "not found");
    const result = reply(200, image.bytes, image.type);
    if (method === "HEAD") result.body = "";
    return result;
  }
  if (!input.snapshot) return reply(503, "collecting");
  const prefs = input.prefs || loadDashPrefs();
  const masked = filterWebSnapshot(input.snapshot, prefs.privacyMode);
  if (match[2] === "snapshot.json") {
    const body = JSON.stringify({ ts: masked.ts || 0, ai: { sessions: take(masked.ai?.sessions, 12), attention: take(masked.ai?.attention, 8), usage: masked.ai?.usage || {} } });
    const result = reply(200, body, "application/json; charset=utf-8");
    if (method === "HEAD") result.body = "";
    return result;
  }
  const nonce = newNonce();
  const theme = input.theme || loadTheme();
  const hasBackground = input.background === undefined ? !!resolveBackgroundPath() : !!input.background;
  const bgRev = input.background === undefined ? backgroundRevision() : (hasBackground ? "1-1" : "");
  const html = renderPage(masked, pagePath, nonce, prefs, theme, hasBackground, bgRev);
  const result = reply(200, html, "text/html; charset=utf-8", nonce);
  if (method === "HEAD") result.body = "";
  return result;
}

export function loadSnapshot(): any | null {
  const raw = readRegularFileLimited(join(STATE_DIR, SNAPSHOT_NAME), MAX_SNAPSHOT_BYTES);
  if (!raw) return null;
  const parsed = parseJsonBounded(raw, MAX_SNAPSHOT_BYTES, 24);
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function tokenById(config: WebConfig, id: string): WebToken | null {
  const wanted = validTokenId(id);
  if (!wanted) return config.tokens[0] || null;
  return config.tokens.find(row => row.id === wanted) || null;
}

export function publishSnapshot(snapshot: unknown): boolean {
  if (!loadConfig()) return false;
  try {
    return writePrivateStateFile(STATE_DIR, SNAPSHOT_NAME, JSON.stringify(snapshot));
  } catch {
    return false;
  }
}

export function disableWebFiles(): void {
  withStateLock(STATE_DIR, "web-config.lock", () => {
    const existing = loadOrReplaceLegacyLocked();
    if (existing) {
      existing.listening = false;
      if (!saveConfig(existing)) throw new Error("Cannot disable Web Mode");
    }
  });
  try { if (existsSync(join(STATE_DIR, SNAPSHOT_NAME))) unlinkSync(join(STATE_DIR, SNAPSHOT_NAME)); } catch {}
}

const hits = new Map<string, { window: number; count: number }>();
function rateOk(ip: string): boolean {
  const now = Date.now();
  const row = hits.get(ip);
  if (!row || now - row.window >= RATE_WINDOW_MS) {
    if (!row && hits.size >= 256) hits.delete(hits.keys().next().value!);
    hits.set(ip, { window: now, count: 1 });
    return true;
  }
  row.count++;
  return row.count <= RATE_MAX;
}

function processStart(pid: number): string {
  const raw = readRegularFileLimited(`/proc/${pid}/stat`, 4096);
  return raw ? raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19] || "" : "";
}

function writeWebStatus(ready: boolean, mode: string, origin: string, message: string): void {
  writePrivateStateFile(STATE_DIR, "web-status.json", JSON.stringify({ ready, mode, origin, message, pid: process.pid, start: processStart(process.pid) }));
}

export function webStatus(): { running: boolean; ready: boolean; mode: string; origin: string; message: string } {
  const raw = readRegularFileLimited(join(STATE_DIR, "web-status.json"), 4096);
  const s = raw ? parseJsonBounded(raw, 100, 3) : null;
  const running = s && Number.isInteger(s.pid) && s.pid > 1 && s.start && processStart(s.pid) === s.start;
  const ready = !!(running && s.ready === true && loadConfig()?.listening);
  const origin = String(s?.origin || "");
  const mode = s?.mode === "manual" || s?.mode === "tailscale" ? s.mode : "";
  // Only an HTTPS origin of the recorded mode can report ready.
  const valid = (() => {
    try { return mode === "manual" ? validManualOrigin(origin) : mode === "tailscale" && tailOrigin(new URL(origin).hostname) === origin; } catch { return false; }
  })();
  return { running: !!running, ready: ready && valid, mode, origin: ready && valid ? origin : "",
    message: String(s?.message || (ready ? "" : "Listener is not running. Choose RETRY SETUP to try again.")).replace(/[<>\u0000-\u001f]/g, " ").slice(0, 400) };
}

export const ACCESS_MODES = ["tailscale", "manual"];
export const LAN_REMOVED_MESSAGE = "LAN HTTP was removed. Choose Private HTTPS or Manual HTTPS in SETTINGS.";

// A missing, legacy "lan" or unknown mode starts nothing. It never falls back
// to another mode, and it runs before any credential file is created.
export function refuseAccessMode(mode: unknown): boolean {
  if (typeof mode === "string" && ACCESS_MODES.includes(mode)) return false;
  writeWebStatus(false, "", "", LAN_REMOVED_MESSAGE);
  console.log(JSON.stringify({ ok: false, message: LAN_REMOVED_MESSAGE }));
  return true;
}

export async function serve(mode = process.argv[3], integration = { inspectTailscale, startServe, serveMappingReady }) {
  if (!ACCESS_MODES.includes(mode)) throw new Error("Unknown Web Mode access mode");
  const extra = process.argv.filter(arg => parseCidr(arg)).slice(0, MAX_EXTRA_CIDRS);
  const config = ensureConfig(extra, true);
  const requestedPort = process.env.INFOMARCHY_WEB_PORT === "0" ? 0 : (validPort(process.env.INFOMARCHY_WEB_PORT) || config.port);
  const tailscale = mode === "tailscale";
  writeWebStatus(false, mode, "", "Starting listener…");
  let manual: ReturnType<typeof loadManualTls> | null = null;
  if (mode === "manual") {
    try { manual = loadManualTls(readManualPrefs()); }
    catch (e) {
      const message = e instanceof Error ? e.message : "Manual HTTPS setup failed.";
      writeWebStatus(false, mode, "", message);
      console.log(JSON.stringify({ ok: false, message }));
      return;
    }
  }
  let externalOrigin = manual?.origin || "";
  let proxy: ReturnType<typeof startServe> | null = null;
  let ready = !tailscale;
  if (tailscale) {
    const status = await integration.inspectTailscale();
    if (!status.ok) {
      writeWebStatus(false, "tailscale", "", status.message);
      console.log(JSON.stringify({ ok: false, message: status.message }));
      return;
    }
    externalOrigin = status.origin;
  }
  const server = Bun.serve({
    hostname: manual ? manual.config.bind : "127.0.0.1",
    port: manual ? manual.config.port : requestedPort,
    ...(manual ? { tls: manual.tls } : {}),
    maxRequestBodySize: MAX_REQUEST_BYTES,
    idleTimeout: 10,
    async fetch(req, srv) {
      const sourceIp = canonicalIp(srv.requestIP(req)?.address || "");
      const url = new URL(req.url);
      const live = loadConfig();
      const candidate = url.pathname.match(/^\/t\/([0-9a-f]{48})\//)?.[1] || "";
      const viewer = live?.tokens.find(row => tokensEqual(candidate, row.token));
      // Serve connects every viewer from loopback. Give authenticated viewers
      // separate budgets; invalid credentials still share the peer IP bucket.
      if (!rateOk(sourceIp + (viewer ? ":" + viewer.id : ""))) return new Response("rate", { status: 429, headers: SECURITY_HEADERS });
      if (!ready || !live || !live.listening || (manual && Date.now() >= manual.expiresAt)) return new Response("unavailable", { status: 503, headers: SECURITY_HEADERS });
      const path = url.pathname;
      const pathname = path.endsWith("/") || path.endsWith("snapshot.json") || path.endsWith("/bg") || path.endsWith("/prefs") ? path : path + "/";
      const result = handleRequest({
        method: req.method,
        pathname,
        host: req.headers.get("host") || "",
        origin: req.headers.get("origin"),
        sourceIp,
        contentLength: Number(req.headers.get("content-length") || 0),
        tokens: live.tokens,
        externalOrigin,
        manualTls: !!manual,
        cidrs: parseCidrList(live.extraCidrs),
        snapshot: loadSnapshot(),
        body: req.method.toUpperCase() === "POST" ? await req.text() : "",
        contentType: req.headers.get("content-type") || "",
      });
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  });
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (expiryTimer) clearInterval(expiryTimer);
    ready = false;
    server.stop(true);
    proxy?.kill("SIGKILL");
  };
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("exit", stop);
  if (manual) expiryTimer = setInterval(() => {
    if (Date.now() >= manual.expiresAt) {
      stop();
      writeWebStatus(false, "manual", "", "Certificate expired. Install a valid certificate, update its fingerprint and retry.");
    }
  }, 30000);
  if (tailscale) {
    writeWebStatus(false, "tailscale", "", "Configuring private HTTPS…");
    proxy = integration.startServe(server.port);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && proxy.exitCode === null) {
      if (await integration.serveMappingReady(externalOrigin, server.port)) { ready = true; break; }
      await Bun.sleep(400);
    }
    if (!ready) {
      stop();
      const message = "Serve setup failed. Enable MagicDNS and HTTPS certificates in the Tailscale admin console. Check local Serve permissions, then retry. No other listener was started.";
      writeWebStatus(false, "tailscale", "", message);
      console.log(JSON.stringify({ ok: false, message }));
      return;
    }
    proxy.exited.then(() => {
      stop();
      writeWebStatus(false, "tailscale", "", "Tailscale Serve stopped. Check the connection and choose RETRY SETUP.");
    });
  }
  writeWebStatus(true, mode, externalOrigin, "");
  console.log(JSON.stringify({ ok: true, ready: true, port: server.port, mode }));
}

if (import.meta.main) {
  const cmd = process.argv[2] || "serve";
  if (cmd === "disable") {
    disableWebFiles();
    process.exit(0);
  }
  if (cmd === "status") {
    const { origin, ...status } = webStatus();
    console.log(JSON.stringify({ ok: true, ...status }));
    process.exit(0);
  }
  if (cmd === "url" || cmd === "copy-url") {
    // A viewer link is a live credential. `url` prints only the token id and
    // its last four characters unless --reveal is given, in any argument order.
    const args = process.argv.slice(3);
    const reveal = cmd === "url" && args.includes("--reveal");
    const id = args.find(arg => arg !== "--reveal") || "";
    const config = loadConfig();
    const status = webStatus();
    if (!config || !status.ready) {
      await Bun.write(Bun.stdout, JSON.stringify({ ok: false }) + "\n");
      process.exit(0);
    }
    const row = tokenById(config, id);
    if (!row) {
      await Bun.write(Bun.stdout, JSON.stringify({ ok: false }) + "\n");
      process.exit(0);
    }
    const url = `${status.origin}/t/${row.token}/`;
    if (cmd === "copy-url") {
      const ok = await copyWebLink(url);
      if (ok) clearLegacyNotice();
      console.log(JSON.stringify({ ok, message: ok ? "Viewer link copied." : "Cannot copy link. Install wl-clipboard and check the Wayland session." }));
      process.exit(ok ? 0 : 1);
    } else if (reveal) {
      clearLegacyNotice();
      console.log(JSON.stringify({ ok: true, url, id: row.id, label: row.label }));
    }
    else console.log(JSON.stringify({ ok: true, id: row.id, label: row.label, suffix: row.token.slice(-4), hint: "add --reveal to print the full viewer link" }));
    process.exit(0);
  }
  if (cmd === "tokens") {
    // Both desk instances call this at load, so it replaces a pre-release file
    // and reports the notice, but never clears it or prints a token.
    const config = loadConfigForSettings();
    if (!config) {
      await Bun.write(Bun.stdout, JSON.stringify({ ok: false, tokens: [] }) + "\n");
      process.exit(0);
    }
    await Bun.write(Bun.stdout, JSON.stringify({ ok: true, tokens: publicTokenList(config), extraCidrs: config.extraCidrs, defaults: DEFAULT_CIDRS, listening: config.listening,
      ...(config.legacyReplaced ? { notice: LEGACY_NOTICE } : {}) }) + "\n");
    process.exit(0);
  }
  if (cmd === "token-add") {
    const created = addWebToken(process.argv[3] || "token");
    await Bun.write(Bun.stdout, JSON.stringify(created ? { ok: true, id: created.id, label: created.label } : { ok: false }) + "\n");
    process.exit(created ? 0 : 1);
  }
  if (cmd === "token-revoke") {
    const reason = revokeWebToken(process.argv[3] || "");
    await Bun.write(Bun.stdout, JSON.stringify({ ok: reason === "revoked", reason }) + "\n");
    process.exit(REVOKE_EXIT[reason]);
  }
  if (cmd === "cidr-add") {
    const ok = addExtraCidr(process.argv[3] || "");
    await Bun.write(Bun.stdout, JSON.stringify({ ok }) + "\n");
    process.exit(ok ? 0 : 1);
  }
  if (cmd === "cidr-remove") {
    const ok = removeExtraCidr(process.argv[3] || "");
    await Bun.write(Bun.stdout, JSON.stringify({ ok }) + "\n");
    process.exit(ok ? 0 : 1);
  }
  if (cmd === "cidrs") {
    const config = ensureConfig(process.argv.slice(3));
    await Bun.write(Bun.stdout, JSON.stringify({ ok: true, extraCidrs: config.extraCidrs, defaults: DEFAULT_CIDRS }) + "\n");
    process.exit(0);
  }
  if (cmd === "qr") {
    const config = loadConfig();
    const status = webStatus();
    if (!config || !status.ready) {
      await Bun.write(Bun.stdout, JSON.stringify({ ok: false }) + "\n");
      process.exit(0);
    }
    const row = tokenById(config, process.argv[3] || "");
    if (!row) {
      await Bun.write(Bun.stdout, JSON.stringify({ ok: false }) + "\n");
      process.exit(0);
    }
    const rows = await qrMatrixForUrl(`${status.origin}/t/${row.token}/`);
    if (rows.length) clearLegacyNotice();
    await Bun.write(Bun.stdout, JSON.stringify({ ok: rows.length > 0, size: rows.length, rows }) + "\n");
    process.exit(rows.length ? 0 : 1);
  }
  if (refuseAccessMode(process.argv[3])) process.exit(1);
  try { await serve(); }
  catch {
    writeWebStatus(false, process.argv[3], "", "Listener setup failed. Check port availability and state-file permissions, then retry.");
    console.log(JSON.stringify({ ok: false, message: "Listener setup failed. Check port availability and state-file permissions, then retry." }));
    process.exit(1);
  }
}
