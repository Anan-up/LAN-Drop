[English](README.md) | [简体中文](README_Simplified_Chinese.md) | [繁體中文](README_Classical_Chinese.md)

# LAN P2P File Transfer

A pure-white, minimalist web-based file transfer tool. Files travel between browsers over a **WebRTC peer-to-peer direct connection** and **never pass through a server relay**—the server only hosts the page and brokers the connection (WebSocket signaling). Ideal for sending files directly from one device to another on the same LAN, without any third-party server in the middle.

## Features

- **Truly peer-to-peer**: File data travels over the WebRTC DataChannel; the server only relays the handshake information needed to establish the connection (SDP / ICE) and never touches a single file byte.
- **Pure-white minimalist UI**: No superfluous decoration, monochrome accents, mobile-responsive.
- **Multi-file / bidirectional transfer**: Drag-and-drop and multi-select supported; sender and receiver can work simultaneously.
- **Reliable transfer**: 64 KB chunks + backpressure control (`bufferedAmount`), in-order reassembly, with real-time progress.
- **Stable negotiation**: Uses the WebRTC "perfect negotiation" pattern; the `polite` role is assigned by the server, eliminating mutual deadlock.
- **Auto-reconnect**: Exponential backoff auto-reconnect after WebSocket drops, returning to the original room; after the peer leaves you can wait for it to reconnect or leave at any time.
- **Streaming to disk**: In browsers supporting the File System Access API (HTTPS / localhost), received chunks are written straight to disk, **never buffering the whole file in memory**—even multi-GB files won't blow up memory; otherwise it falls back to a Blob download automatically.
- **Resume from breakpoint**: If the connection drops mid-transfer and recovers, the receiver continues from the bytes already written—no restart from scratch (valid within the same page session).
- **QR-code pairing**: One-click room QR code (with a shareable join link); the other party scans to auto-fill the room code and join, no manual code entry.
- **Receiver can reject / sender can retry**: The receiver can click "Reject" on an incoming file (the sender learns immediately and no longer waits idly for 5 minutes); once the sender fails (peer rejected / not ready / connection dropped), a "Retry" button appears to resend with one click, sparing you from re-dragging the file.
- **Stronger security**: The server sends a CSP response header (same-origin only; since WebSocket is same-origin, `connect-src 'self'` already covers it), and limits room-code length, WebSocket message body size (`maxPayload`), and per-connection message rate to fend off malicious / mis-sent requests on the LAN.
- **Zero-config deployment**: A single `Express` + `ws` process; HTTP / HTTPS auto-adapts.

## How It Works

```
┌──────────────┐         WebSocket signaling (handshake only)      ┌──────────────┐
│  Browser A   │  ──────────────────────────────────────────────▶ │  Signal srv  │
│  (Sender)    │  ◀────────────────────────────────────────────── │  (this proc) │
└──────┬───────┘                                                   └──────┬───────┘
       │                                                                  │
       │              WebRTC DataChannel (file bytes, direct)             │
       └──────────────────────────────────────────────────────────────────┘
                                                                          │
┌──────────────┐                                                          ▼
│  Browser B   │  ◀──────── WebRTC DataChannel (file bytes, direct) ─────┘
│  (Receiver)  │
└──────────────┘
```

1. Both browsers open the server address and enter the **same room code** to join the same room.
2. The server notifies both sides they may begin negotiation (`peer-ready`, and assigns one `polite` / one `impolite` role).
3. The two ends exchange SDP / ICE candidates over WebSocket to establish the P2P connection.
4. Once connected, files transfer directly over the DataChannel; the server no longer participates.

> On a LAN the local candidate address is preferred for the direct connection—lowest latency, no public bandwidth used. A public STUN is included for candidate discovery only; it relays no file data.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

Listens on port `3000` by default. Change the port via env var:

```bash
PORT=8080 npm start
```

### 3. Open in browser

- Local: `http://localhost:3000`
- Other devices on the LAN: replace `localhost` with **the server's LAN IP**, e.g. `http://192.168.1.50:3000`

### 4. Start transferring

1. Both browsers open the LAN address above.
2. One side clicks "Random" to generate a room code (or types one manually) and clicks "Join"; the other side enters the **same room code** to join, or clicks "Generate QR Invite" so the other scans to join.
3. Once the status dot turns green "Connected · ready to transfer", drag files into the box (multi-select and bidirectional transfer supported).
4. **Receiver**: In browsers supporting File System Access (HTTPS / localhost), a "Save as…" button appears first; click it to pick a save location, then receiving starts and streams to disk; other environments receive directly and you click "Download" when done to save locally.
5. **Resume from breakpoint**: If the connection drops mid-transfer, once recovered both sides automatically continue from the breakpoint and the progress bar keeps going—no re-transfer needed.

## Deployment

- **Firewall**: Make sure the server port (default 3000) is reachable on the LAN.
- **HTTPS**: When deployed over HTTPS, WebSocket auto-upgrades to `wss://` with no code changes. HTTPS is recommended in production, ideally behind a reverse proxy (Nginx, etc.).
- **Cross-subnet / public network (TURN)**: Currently designed for pure LAN direct connection. Cross-subnet or cross-public-network scenarios need a TURN relay (which would go through a relay). **No front-end code change is needed**—just set the `ICE_SERVERS` env var, e.g.:
  ```bash
  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start
  ```
  The front end reads this config from `/config.json` at startup for `RTCPeerConnection`.

## Project Structure

```
.
├── server.js            # Express serves static pages + WebSocket signaling relay (handshake only, no file bytes)
├── public/
│   ├── index.html       # Pure-white minimalist UI
│   ├── style.css        # Minimalist styles (white bg, black/gray text, thin lines, monochrome progress bar)
│   ├── app.js           # WebRTC connection, chunked transfer, backpressure, streaming to disk, resume, QR code
│   └── vendor/
│       └── qrcode.js    # Locally bundled QR generation lib (zero-dep, works offline on a pure LAN)
├── package.json
└── package-lock.json
```

## Key Issues Handled (Implementation Notes)

- **`polite` assigned by server**: Perfect negotiation requires both roles to be fixed; the server assigns one `polite` / one `impolite` by join order, ruling out the deadlock of "both impolite, each waiting for the other's answer".
- **Sender serialization**: `sendQueue` + `pump()` ensure `meta → chunk → done` never interleave across multiple files, and the receiver reassembles correctly with a single `recvCtx`.
- **`pump` deadlock guard**: `pump` uses `try/finally` to guarantee `sending` is always reset; `sendFile` re-checks channel state after the async `arrayBuffer()` read, so no pass-through exception is thrown inside the disconnect window.
- **Backpressure hang guard**: While waiting for `bufferedamountlow`, also listen for channel `close`, so a dropped peer never hangs forever.
- **`connect()` idempotent**: The auto-reconnect timer and manual connect never create multiple WebSockets.
- **`pc.close()` null-ref guard**: Unbind all event handlers before closing, avoiding an async state change reading an already-nulled `pc`.
- **Reconnect-return fix**: `doJoin` prefers `joinedRoom`, so after a drop it auto-returns to the original room.
- **Resource cleanup**: `resetConnection` clears the pending send queue, releases the receiver's Blob URLs, and recycles expired download links up to a cap—avoiding memory buildup and leaks.
- **Connection-state granularity**: `disconnected` (a possibly self-healing transient) is reported separately from `failed` / `closed`.
- **Streaming to disk**: After `file-meta` the receiver triggers `showSaveFilePicker` via a user gesture, gets a writable stream, then tells the sender (`recv-ready`) to start chunks; chunks are written straight with `writer.write`, keeping memory constant. Falls back to Blob + download link when unsupported.
- **Resume from breakpoint (in-session)**: The sender keeps `{file, item}` in `sendCtxById` for resume (not cleared by `resetConnection`); the receiver's `recvCtx` (writable stream / received offset) is kept by default mid-transfer. After reconnect, the receiver channel's `onopen` fires `maybeResume`, sending `resume-request {id, offset}` to the sender, which resumes from the breakpoint.
- **QR-code pairing**: The `?room=` room code is parsed by `app.js` at init and auto-joins; the "Generate QR Invite" button uses the locally bundled `qrcode-generator` to produce a join-link QR (content includes `location.origin`; the scanning device must be able to reach that server address). This button is independent of the join row and works before or after connecting.
- **Reject / retry protocol**: Receiver "Reject" sends `recv-reject`, the sender immediately resolves `waitRecvReady` with `false` (no more 5-minute idle wait) and, based on `ctx.rejected`, shows "Peer rejected" + "Retry"; all sender failure branches funnel through `fail()` to add the retry entry, and `retryFile(id)` reuses the `file` kept in `sendCtxById` to re-enqueue.
- **`waitRecvReady` disconnect release**: `resetConnection` no longer just clears `pendingRecvReady` but `clearTimeout` each one and `resolve` with `false`, so after the peer drops the sender won't hang waiting for receiver-ready for up to 5 minutes.
- **Race guard (state after channel await)**: During the async `writer.close()` in `file-done` and the `showSaveFilePicker` dialog in `addSaveButton`, a local `ctx` / `recvCtx` reference is captured first and re-checked after `await` to still be the current context—avoiding a `TypeError` from reading `null` after the peer's drop triggered `resetConnection`.
- **Post-reject state consistency (P0-A)**: On "Reject" the receiver disables and rewrites the "Save as…" and "Reject" buttons, and `addSaveButton`'s callback re-checks `ctx.done` after the save dialog returns—preventing "reject then save" from leaking a writer, sending a stray `recv-ready`, and putting the receiver into a "waiting for data forever" dead state.
- **Retry doesn't false-report reject (P0-B)**: `retryFile` does `delete ctx.rejected` before retrying, so a second timeout (receiver neither saves nor rejects) correctly shows "Peer didn't save" rather than wrongly carrying the previous reject flag and showing "Peer rejected".
- **Unified failure funnel (P0-C / P1)**: The async `arrayBuffer()` drop in `sendFile` and the `pump` catch both funnel through `fail()` to add the retry button, eliminating missing retry entries in some branches and logic drift between the two.
- **Random strings via `crypto`**: Room code (`randRoom`) and file id (`fileId`, UUIDv4) now use `crypto.getRandomValues` instead of `Math.random`, avoiding collisions on the file id (which also serves as the resume key).
- **Clearer `resetConnection` semantics**: The argument is now an options object `{ keepJoinUI, full }`; whether to keep the in-transfer file is derived from "is there an unfinished `recvCtx`", removing the old ambiguity of `keepTransfer` being force-overwritten.
- **Server robustness**: Room-code length check (1–64, too long returns `bad-room`), `WebSocketServer` with `maxPayload: 8KB`, a sliding-window rate limit of 100 messages per 1s per connection (counted **before** `JSON.parse`, so illegal JSON also counts and can't be bypassed by spinning), `try/catch` on `send`, and client `ws.onmessage` ignoring illegal JSON—all preventing white screens or resource exhaustion from invalid / malicious LAN requests.
- **CSP and ICE config delivery**: The server uniformly sets `Content-Security-Policy` (`default-src 'self'`; `img-src` whitelist includes `data:` to allow `qrcode.js`'s `data:image/gif`; `connect-src 'self'` already covers same-origin WebSocket, no longer allowing arbitrary `ws:`/`wss:` addresses, tightening the injection/outbound surface); a new `GET /config.json` exposes the `ICE_SERVERS` env var, and the front end uses an `iceConfigReady` promise to `await` in `createConnection` before building `RTCPeerConnection`—adding TURN for cross-public-network needs no front-end change, and the `?room=` auto-join already has TURN ready.
- **`file-done` loss fix (edge P1)**: If the sender's `sendChannel.send({type:'file-done'})` after chunks throws inside the disconnect window, it goes to `fail()` with `sendCtxById` kept; after reconnect the receiver's `resume-request` would be ignored because `offset >= size` and it would wait forever for `file-done` at 100%. The `resume-request` branch now special-cases it: when the receiver has all bytes (`offset >= size`) and the channel is still open, it **re-sends one `file-done`** to finish and deletes `sendCtxById`, and the receiver completes normally.
- **P3 timing cleanup (long-tail timing, zero-risk cleanup, all per review diff)**:
  - **`await writer.close()` window in `file-done`**: This branch now sets `recvCtx = null` **before** awaiting, avoiding a same-id new `file-meta` (sender retrying right then) reusing the DOM and mislabeling the new node "completed" with misaligned progress; `resetConnection`'s `recvCtx && !recvCtx.done` check short-circuits on null and is unaffected.
  - **`maybeResume` at `received === 0`**: When a writable stream exists but `received === 0`, it now goes to `reAddSaveButton` (let the user re-pick a save location)—cleaner than re-sending an empty `file-meta` only to be `writer.abort()`-ed, avoiding the "ready → save as…" button flicker; the Blob fallback branch keeps a direct resume (empty transfer is harmless).
  - **`roomInput` visual jitter on disconnect**: `resetConnection` only clears the input box when the user leaves voluntarily (`full:true`); disconnect-reconnect no longer clears it (`joinedRoom` remains, auto `doJoin` after reconnect).
- **Room lifecycle completion (this review round)**:
  - **`full` no longer leaves orphan connections**: The `full` (room full) branch used to only clear `joinedRoom` and the join row; if the user was connected in an old room and switched to a full room, the old `pc` would linger as an orphan, and later WS jitter couldn't reconnect to the original room. Now it calls `resetConnection({ full: true })` to drop the old P2P first, then return to the join UI.
  - **"Leave" button shows on `joined`**: Right after entering a room (alone-waiting or already connected) `leaveBtn.hidden = false`, so you can switch rooms mid-way by clicking "Leave" without refreshing.
  - **`onFileMeta` selector uses `CSS.escape`**: `lists.querySelector('.item[data-id="..."]')` id is passed through `CSS.escape`, defending against any file id breaking the selector (current id is UUIDv4 hex, actually unaffected—defensive hardening).
  - **`createConnection` concurrency-leak + orphan-pc guard (P2)**: After `await iceConfigReady`, first add `if (!ws || ws.readyState !== WebSocket.OPEN) return;` (using the static constant `WebSocket.OPEN`), then `if (pc) return;`. The former blocks the "WS drops and reconnects while `iceConfigReady` is pending" scenario—`if (pc) return` alone would still create an orphan `pc` in that window, and because `pc` is non-null the reconnected `peer-ready` gets skipped and negotiation never completes; the new ws-alive check makes the pending-and-already-dropped call return directly, then build `pc` normally once reconnected OPEN. The two cooperate, zero impact on the normal path.
- **Keep completed list across disconnect jitter (edge P1)**: `resetConnection`'s `keepTransfer` used to clear the whole list whenever `recvCtx` was `done`/empty, so a brief WS jitter lost all completed-file UI and download links. Now it keeps the list if "there's an unfinished receive **or** the list has a `.item.done` entry", clearing only on voluntary leave (`full:true`); it neither drops completed history nor leaves an empty list when there's no transfer.
- **`recvUrls` revoke follows `keepTransfer` (edge P2, symmetric fix to last round)**: After last round added "keep completed history" to `keepTransfer`, the unconditional `revokeObjectURL` still voided all kept "download" links on disconnect-reconnect, turning them into dead links. The revoke block is now wrapped in `if (!keepTransfer)`, so links kept across reconnect are actually usable, and only a voluntary leave (`full:true`) clears them all at once; `MAX_RECV_URLS = 8` guarantees no unbounded growth even without revoke.
- **`'bad-room'` orphan connection (edge P2, symmetric with `'full'`)**: The `bad-room` branch in `handleWs` used to only `resetJoinUI()`; when the user was connected in an old room's P2P and entered an over-long / illegal room code and failed to switch, it left an orphan "WS not in any room but `pc` still connected". Now, like the `full` branch, it uses `resetConnection({ full: true })` (which calls `resetJoinUI` internally) to drop the old P2P before prompting, avoiding the inability to auto-reconnect after a drop.
- **Retry reuses DOM entry (edge P2)**: When the receiver's `onFileMeta` gets a same-id `file-meta` (sender clicked "Retry", id unchanged), it used to create a second DOM node, showing two same-name same-size items. Now it first checks `lists.querySelector('.item[data-id="<id>"]')`, and on hit **reuses** the original entry (clears `done`, resets progress, removes old action area) before receiving; and as a bonus `addItem` now sets `item.dataset.id = id` (the `id` param was previously unused—both a needed fix and a code smell removed).

## Known Limitations / Future Directions

- **Large-file memory**: Solved via streaming to disk in a secure context (HTTPS / localhost); but when accessed over an HTTP LAN IP (non-localhost), the browser doesn't provide the File System Access API and automatically falls back to full Blob caching, so multi-GB files still consume memory. HTTPS is required to enjoy streaming to disk.
- **Resume scope**: Limited to a connection that drops and recovers **within the same page session**. After a page refresh the file handle / writable stream is lost and transfer restarts from scratch (File System Access permission can't survive a refresh, and IndexedDB persistence isn't introduced).
- **Cross-public-network**: Requires adding TURN config.
- **Iterable features**: Persisted resume after refresh (IndexedDB), whole-folder transfer.

## Automated Verification

The project ships real browser end-to-end tests (Playwright + headless Chromium) covering runtime issues a static review can't catch:

- **Basic chain**: Both ends establish a WebRTC P2P connection via the local signaling server, QR generation, a 1MB file transfer with received content byte-for-byte identical to the original, sender progress bar reaching 100%, and zero console errors on either end.
- **Resume (realistic)**: A 10MB file transfer is mid-way partitioned via `setOffline` to simulate a network split; both ends auto-reconnect and resume from the breakpoint, the file is still byte-for-byte identical, and the state recovers to connected.
- **Reject / retry / CSP**: After the receiver "Rejects", the sender immediately shows "Peer rejected" and a "Retry" button appears; clicking retry re-proposes (receiver shows the save button again); via the File System Access path (injecting a fake `showSaveFilePicker`) it verifies streaming-to-disk "Saved locally"; the QR generates normally under CSP using `data:image/gif`, zero console errors throughout.
- **Race focus (P0-A)**: Inject a controllable `showSaveFilePicker` to simulate the race "click save (dialog hangs) → click reject while the save dialog waits → dialog returns", verifying the fix creates no writer, sends no `recv-ready` to the sender, and leaves the receiver in "Rejected".
- **Retry false-report focus (P0-B)**: Temporarily shorten `RECV_READY_TIMEOUT` to 2s, verifying "Reject → Retry → receiver does nothing until timeout" ultimately shows "Peer didn't save" rather than falsely "Peer rejected".
- **Failure funnel focus (P0-C / P1)**: Queue a file right after only the sender joins, verifying `sendFile` immediately goes to `fail()` showing "Connection dropped" with a "Retry" button; after the second end joins and retry is clicked, it rebuilds the connection and transfers successfully (streaming to disk "Saved locally").

Issues found and fixed during testing: After connecting, the "QR" button was "visible but unclickable" because it sat inside the disabled join row; it has been moved out of the join row into an always-clickable "Generate QR Invite".

> Note: To eliminate interference from the "gesture save dialog" in automation, the tests force the Blob fallback path to verify **data-plane** correctness; streaming to disk (File System Access) and the "gesture save dialog" interaction still need manual verification in a real browser that supports the API.

The 3 new edge fixes this round (① `file-done` lost in the disconnect window, ② disconnect jitter clearing the completed list, ③ same-id retry duplicate entry) are all long-tail scenarios at the level of "the connection drops exactly at some await / the user happens to click retry", hard to reproduce with stable E2E (automatically triggering "file-done happens to throw on `send` exactly when the DataChannel closes" would be very flaky). Therefore this round relies on **precise logic review + `node --check` syntax validation + full regression of existing E2E still with zero console errors**: all changes are local branch adjustments that don't touch the verified main chain (perfect negotiation, backpressure, streaming to disk, resume, reject, retry, CSP, rate limiting), so the existing P0/A/B/C and P1 behavior is unaffected.

## License

[MIT](LICENSE)
