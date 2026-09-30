# Web Mode security design

See [README setup](../README.md#set-up-web-mode) for user instructions.

## Scope and rationale

Web Mode supports two mutually exclusive access modes, both HTTPS: private HTTPS through Tailscale Serve, and direct Manual HTTPS with existing certificate files. Desktop-owned privacy is enforced before responses leave the server. Network reachability, transport encryption, and viewer-token authorization are separate checks.

For Tailscale mode, Tailscale owns private connectivity and HTTPS certificate lifecycle, and Infomarchy owns disclosure, viewer credentials, and its forwarding process. Manual HTTPS delegates issuance, DNS, client trust and renewal to the operator. Neither mode requires DNS-provider credentials, trust-store installation, or certificate renewal machinery inside the plugin. Public exposure, Funnel, built-in CA/ACME, pairing-to-cookie sessions, and per-viewer roles are outside this implementation. They are not pending approved requirements.

## Disclosure policy

Only a persisted literal boolean `true` in desktop `privacyMode` enables privacy. Missing, unreadable, invalid, or malformed settings read as off, the same way the desk reads them, so the browser never masks what the desk shows or shows what the desk masks. Viewer tokens, not the privacy mask, are the access boundary. Desktop preference changes are field-specific patches, including per-key map edits, rather than cached whole-file snapshots. `dashboard-state.ts` merges each patch into freshly read settings under `dashboard.lock`, and the browser layout writer uses that same transaction. Unrelated stale desktop/browser edits cannot restore privacy-off, WEB-on, or a previous access mode. Each QML instance queues writes through startup and reloads persisted state after completion. Failures are visible and reload saved settings.

The browser's privacy label is read-only, and the layout preference endpoint rejects unexpected keys, including privacy mutations.

`filterWebSnapshot` applies a shared disclosure policy to HTML and JSON without modifying the desktop source snapshot. With privacy on, it omits WAN/LAN addresses, SSID and user/host identity, shortens home mounts, and truncates recent prompts after four words using the existing mask. Hidden elements, attributes, scripts, and JSON must not retain full values. Session topics are dropped from sessions and attention rows, never shortened, because a topic is keywords lifted verbatim from the prompts. The desk drops them the same way (`displayTopic`), so desk and browser agree. Project names and short prompts remain visible by design. This is partial disclosure, not comprehensive anonymization.

The filtered view names every object field it keeps, machine telemetry included, so a new collector field reaches a browser only when it is added there. Heatmap, day and daily-token arrays carry numbers and dates only, and heatmap cells keep their per-kind counts as numbers. FLEET, APPS, CONTAINERS, GITEA and new usage or machine fields stay on the desk. GitHub login remains excluded at either privacy setting. JSON sessions, attention, and usage are projected to web fields rather than forwarding desktop action arguments, working directories, previews, or extra provider data. Desktop COPY EXCERPT retains full text.

Privacy off permits connected viewers to receive the allowed full values. Changes apply to subsequent responses, normally the next successful five-second refresh. Already received/saved data cannot be retracted, and disconnected pages may retain old content.

## Access boundaries

### Removed: LAN HTTP

Pre-release builds of Web Mode offered a third mode that bound `0.0.0.0:8787` without TLS, so the dashboard and the bearer token in the URL crossed the network in cleartext. It was removed. The listener refuses any mode other than `tailscale` or `manual`, including a missing mode and `lan`, before it creates credentials or binds a socket, and reports that LAN HTTP was removed. The settings writer rejects `lan` as a mode. The desk loads a saved `lan`, a missing mode or an unknown value as no mode, with WEB off, and never substitutes another mode. If such a setting was saved with WEB on, the desk saves WEB off once, marks `web.json` not listening and deletes `web-snapshot.json`, so the collector stops writing it. WEB stays off until the operator chooses a mode.

Every `web.json` this build writes carries `version: 2`. A file without it was written by a pre-release build that offered LAN HTTP, so its tokens may have crossed the network in cleartext. Such a file is never accepted as credentials, even before it is replaced. The first credential transaction under `web-config.lock`, including the drawer's token list and `disable`, replaces it once: one new token per old label, the same port and allow list, and not listening. The drawer then says that viewer links were replaced and asks for a new link for each viewer. The notice clears when the first new link is copied, shown as a QR or printed with `--reveal`. No old or new token is printed.

### Private HTTPS

The backend binds `127.0.0.1`. A dedicated foreground `tailscale serve --https=8788 http://127.0.0.1:8787` process provides private HTTPS. The application requires a loopback TCP peer, the exact HTTPS Host/Origin derived from local Tailscale status, and a valid viewer token. It does not trust forwarded or Tailscale identity headers. A local process holding a token can access loopback with the correct Host. This does not isolate the service from other processes running as the user.

Inspection checks the installed CLI, connection, DNS name, required Serve options, and existing Serve configuration using bounded subprocesses. Existing TCP/Web/Funnel mappings on 8788, including nested foreground mappings, cause refusal. Unrelated services are preserved. No existing background mapping is adopted, no global Serve reset is run, and Funnel is never enabled.

`web-child.py` sets Linux parent-death SIGKILL and checks the parent PID before executing the CLI. Normal listener shutdown and abrupt listener death terminate the owned process, and tailscaled removes its foreground mapping when the CLI connection closes. Plugin removal ends that ownership too. Tailscale itself and unrelated services continue running.

Startup waits for the expected foreground mapping and verifies that it is not Funnel before reporting ready. A failed setup exits without starting any other listener. Selecting another access mode turns WEB off. Installation, login, admin HTTPS/MagicDNS changes, and local permissions are guided rather than automatically changed or escalated.

### Manual HTTPS

README includes an operator-run private-CA/IP-SAN recipe for LAN viewing without DNS or Tailscale. It keeps key material outside the public download directory, limits incoming firewall rules, requires deliberate client CA trust and documents renewal/removal. Those manual steps do not add certificate or firewall management to the plugin.

`web-manual.ts` loads a bounded existing PEM chain and unencrypted PEM private key. Configuration contains a DNS hostname or private IPv4 identity, a specific loopback/private IPv4 bind address, an unprivileged port (default 8789), file references and the expected SHA-256 leaf-certificate fingerprint. Public and wildcard binds are rejected. A VPN bind does not confer source authorization: the existing CIDR allow list still applies. DNS configuration and reachability remain operator-owned.

The default source allow list is loopback and RFC1918. `100.64.0.0/10` is not in it and never proves tailnet membership. CIDRs are reachability filters, not authorization. The user manages firewall rules, and loading settings or enabling WEB does not change them.

Every file path component is opened through held parent descriptors without following symlinks. Parents must be owned by root/the current user and protected against unrelated writers (root-owned sticky temporary directories are allowed). Final files are descriptor-validated for type, owner, link count, permissions and bounded size. Keys must have no group/other permissions. The same validated bytes are passed into TLS, with no later pathname reopen. Crypto errors are replaced by bounded fixed diagnostics, never PEM content.

Startup checks the exact leaf fingerprint, validity of each supplied certificate, DNS SAN coverage for hostnames or exact IP SAN coverage for literal addresses (no CN fallback), matching private key, leaf-not-CA, and supplied issuer signatures/CA flags. This binds the configured identity to the certificate being served. It neither establishes browser trust nor changes signed hostname coverage. Clients perform their own trust-chain verification. A self-signed leaf may be supplied if clients deliberately trust it. A renewal requires an explicit fingerprint update and restart. Running TLS continues using its loaded bytes. Expired loaded certificates stop application responses immediately and stop the listener within 30 seconds.

The listener requires the exact configured HTTPS Host/Origin plus source authorization and a viewer token, without trusting forwarded headers. Browser mutation remains layout-only. Manual settings are desktop-owned, saved through the shared settings transaction, and saving them while Manual HTTPS is selected disables WEB. Read-only CHECK CERTIFICATE does not start sharing or mutate certificates. A rejected setup never opens an HTTP fallback. No trust store, DNS, firewall, CA, issuance or renewal management is performed by the plugin.

## Credentials, requests, and UI

Setup and viewer management are desktop controls in the dashboard SETTINGS drawer. This contribution does not register a bar widget. Every path that turns WEB on passes a gate and fails closed. The drawer requires a chosen mode, no pending save, and a passing Tailscale check or a saved Manual form. The strip WEB chip only opens the drawer when WEB is off. The `toggleWeb` IPC requires a chosen mode and no pending save, then runs the Tailscale status check or the Manual certificate check and enables WEB only if that check passes for the mode still selected. Turning WEB off never waits for a check.

Viewer tokens are individually revocable bearer credentials stored in `web.json` with mode 0600. Credential reads validate the opened descriptor, ownership, link count, mode, and bounded size. Symlinks and invalid files fail closed. Rejected state is not silently replaced with new credentials or stale cached tokens. The one exception is a safe, readable pre-release `web.json` without a version, whose tokens are replaced once as described under Removed: LAN HTTP. A file that fails the safety checks is never rewritten. All credential mutations (creation, token add/revoke, CIDR changes, and enable/disable) acquire `web-config.lock` before reading and retain it through atomic publication. The whole-config writer is private to those transactions, so an unrelated update cannot restore a revoked token from a stale read. Revocation affects subsequent authenticated requests. WEB off keeps credentials. Add a replacement before revoking the last token. `token-revoke` reports `revoked`, `not-found`, `last-token` or `unavailable` (exit 0, 2, 3 or 1), so a refused revoke is never mistaken for a dead credential.

Page access is GET/HEAD. The JSON-only POST `/prefs` requires the expected Origin and accepts only `webSections` and `webNarrowOrder`. Existing escaping, request limits, authentication, no-store responses, and nonce CSP remain. Every response also carries `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`. No HSTS header is sent. A policy would apply to every port on the same host name, and viewer links are always HTTPS. `connect-src 'self'` and `img-src 'self'` restrict page fetches. Rate-limit bookkeeping is bounded and distinguishes authenticated viewers behind the loopback proxy.

`web-status.json` contains noncredential runtime state validated against the live process identity. Startup, `status`, `tokens` and QML polling print token ids and four-character suffixes, never a token. The `url` command prints the same unless `--reveal` is given, so a routine call does not put a live credential into terminal scrollback. The `qr` command returns the link encoded as a QR matrix for the desk to draw, so its output is treated like the link. Deliberate COPY URL or SHOW QR fetches the selected viewer address, and `copyWebUrl` replaces URL-returning IPC. QR is cleared when hidden, settings closes, or the selection/mode changes. Dashboard QR opens the authenticated page. It does not enroll or authorize a Tailscale device.

Requested-on, starting, ready, and failed are distinct UI states. WEB FAILED offers RETRY SETUP after the user fixes a prerequisite. CHECK PREREQUISITES only inspects. Retry uses the service-owned listener lifecycle, preserves WEB-off guards, and ignores duplicate/ready retries. Preflight checks are hidden during starting/ready to avoid treating the owned active mapping as a conflict.

The two lock files are persistent empty 0600 files validated through their opened descriptors. Locks are kernel-owned, have a bounded acquisition wait, and release on descriptor close/process death. Lock files are never unlinked or replaced during normal operation. Invalid locks and failed writes fail closed. Locks coordinate participating Infomarchy writers, not arbitrary same-user programs editing state outside the protocol.

## Residual risks

- The viewer token is in the URL path. It can end up in browser history, history synced to a browser account, the address bar and screenshots. `Referrer-Policy: no-referrer` keeps it out of Referer headers, and the server keeps no request log. A proposed follow-up exchanges the link for a `__Host-` cookie and redirects to a token-free URL.
- Rejected requests are not recorded, so a probe with a leaked or guessed link is not visible. A 192-bit token makes guessing infeasible.
- Any process running as the same user can reach the loopback backend in Private HTTPS mode. It still needs a valid token.
- A viewer's layout change rewrites `dashboard.json`, and the desk runs a local collect after it. The rate limit of 60 requests a minute for each viewer bounds it.
- COPY URL passes `--sensitive` to `wl-copy`, which asks clipboard managers not to keep the link. A manager that ignores the hint can still keep it. An older `wl-copy` without the flag gets one plain retry.

## Validation expectations

For future changes, test distinctive private sentinels against actual HTML/JSON response bytes, privacy transitions, allowed four-word disclosure, topic removal under privacy, and browser mutation attempts. Exercise competing real helper processes and stale QML instances, privacy/WEB-off preservation, revocation during other credential mutations, lock rejection/crash release, and write-failure recovery. Preserve credential/revocation, Host/Origin, CSP, malformed-state, bounded-output, and shutdown tests. Exercise absent/stopped/signed-out Tailscale, conflicts, setup failures, repeated enable/disable, direct-backend boundaries, and crash cleanup. For Manual HTTPS, exercise a real TLS handshake with client trust enabled, SAN/key/fingerprint/expiry failures, unsafe file paths and permissions, Host/Origin/source/token checks, absence of HTTP fallback, and QML save/check/mode-switch behavior. Unit and mocked tests do not replace real-device or QML verification.

Real-device evidence, from before this rework on the branch as first proposed: the user confirmed Android access using the private-CA/IP-SAN setup after a scoped inbound firewall rule, then confirmed access through the restored Tailscale URL. Local probes alone had missed the inbound firewall block. The temporary CA download service and test firewall rule were removed afterward. This validates the exercised setup, not every client trust store or network.

Reference: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [HTTPS prerequisites](https://tailscale.com/docs/how-to/set-up-https-certificates).
