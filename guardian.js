/**
 * worker/guardian.js - runs INSIDE the Bare worklet (not React Native, not Node).
 *   - InactivityDetector + QVAC (your files, unchanged apart from a lazy import)
 *   - Pear P2P: alerts go straight to the contact's phone over Hyperswarm, no server
 *   - Talks to the screen (src/GuardianScreen.tsx) with newline-delimited JSON over BareKit.IPC
 *
 * Bare has no Buffer / AbortController globals, so we add them before anything runs.
 */
import { Buffer } from "bare-buffer";
import AbortControllerPolyfill from "abort-controller";
import Hyperswarm from "hyperswarm";
import crypto from "hypercore-crypto";
import b4a from "b4a";
import {
  InactivityDetector, defaultActions, makeConfig, setLogger, eventToDict, DEFAULT_ACTION_MAP,
} from "./inactivity.js";
import { createQvac, spokenCheckInText } from "./qvac-helpers.js";

globalThis.Buffer ??= Buffer;
globalThis.AbortController ??= AbortControllerPolyfill;

const ipc = BareKit.IPC;
const send = (m) => ipc.write(JSON.stringify(m) + "\n");
const logger = {
  debug() {},
  info: (...a) => send({ t: "log", level: "info", m: a.join(" ") }),
  warn: (...a) => send({ t: "log", level: "warn", m: a.join(" ") }),
  error: (...a) => send({ t: "log", level: "error", m: a.join(" ") }),
};
setLogger(logger);

let detector = null, qvac = null, swarm = null, ticker = null;
const conns = new Set();

// ------------------------------------------------ microphone/speaker live in the UI
// record(): ask the screen to capture `seconds` of 16 kHz mono WAV and send it back.
const pendingClips = new Map();
let clipId = 0;
function record({ signal, seconds }) {
  return new Promise((resolve, reject) => {
    const id = ++clipId;
    pendingClips.set(id, { resolve, reject });
    send({ t: "record", id, seconds });
    signal.addEventListener("abort", () => { pendingClips.delete(id); reject(new Error("aborted")); }, { once: true });
  });
}
// play(): hand the synthesised WAV to the screen to play.
const play = async (wav) => send({ t: "play", wav: b4a.toString(wav, "base64") });

// ------------------------------------------------ Pear / Hyperswarm
function startSwarm(secret, role) {
  swarm = new Hyperswarm();
  swarm.on("connection", (conn) => {
    conns.add(conn);
    send({ t: "peers", n: conns.size });
    conn.on("error", () => {});
    conn.on("close", () => { conns.delete(conn); send({ t: "peers", n: conns.size }); });
    let buf = "";
    conn.on("data", (d) => {
      buf += b4a.toString(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (role === "contact" && msg.t === "alert") send({ t: "remote", e: msg.e });
        } catch { /* ignore junk */ }
      }
    });
  });
  // Anyone who knows the shared secret can join: treat it like a password.
  swarm.join(crypto.discoveryKey(b4a.from(secret)), { server: true, client: true });
}

// Replaces the notifyPlaceholder in inactivity.js: what happened and when, nothing else.
async function notify(event) {
  const line = JSON.stringify({ t: "alert", e: eventToDict(event) }) + "\n";
  for (const c of conns) c.write(line);
  if (conns.size === 0) logger.warn("alert raised but no contact is connected right now");
}

// ------------------------------------------------ commands from the screen
async function init({ secret, role, tzOffsetMinutes, thresholdMinutes }) {
  await teardown();
  startSwarm(secret, role);
  if (role !== "wearer") return send({ t: "ready", role });

  // local time without Intl (Bare may not ship it): offset comes from the phone
  const DAY = 86400000;
  const localClock = (ms) => {
    const l = ms - tzOffsetMinutes * 60000;
    const day = Math.floor(l / DAY);
    return { hour: Math.floor((l - day * DAY) / 3600000), day };
  };

  qvac = createQvac({
    sdk: undefined, record, play, logger,
    // if on-device TTS fails, the phone's own speech engine says it instead
    fallback: async (event) => send({ t: "speak", text: spokenCheckInText(event) }),
  });
  const actions = {
    ...defaultActions(), ...qvac.actions, notify,
    ui: (e) => send({ t: "event", e: eventToDict(e), awaiting: detector.awaitingResponse }),
  };
  const map = Object.fromEntries(Object.entries(DEFAULT_ACTION_MAP).map(([k, v]) => [k, [...v, "ui"]]));
  detector = new InactivityDetector("phone-1", makeConfig({
    timezone: "UTC", defaultThresholdMinutes: thresholdMinutes ?? 180, actions: map,
  }), { actions, localClock });
  qvac.bind(detector);
  ticker = setInterval(() => detector.tick(), 60000);

  send({ t: "ready", role });
  // Models download on first run. Don't block the screen; report failure but stay usable.
  qvac.warmup().then(() => send({ t: "log", level: "info", m: "QVAC models ready" }),
    (e) => send({ t: "log", level: "error", m: `QVAC unavailable (${e?.message}); using phone speech + button only` }));
}

async function teardown() {
  clearInterval(ticker);
  await qvac?.close().catch(() => {});
  await swarm?.destroy().catch(() => {});
  conns.clear(); detector = qvac = swarm = null;
}

let inbuf = "";
ipc.on("data", (d) => {
  inbuf += b4a.toString(d);
  let i;
  while ((i = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m).catch((e) => logger.error(`command ${m.t} failed: ${e?.message}`));
  }
});

async function handle(m) {
  switch (m.t) {
    case "init": return init(m);
    case "reading": return void detector?.process(Date.now(), m.activity);
    case "ack": return void (detector?.awaitingResponse && detector.acknowledge());
    case "simulate": { // N minutes of stillness, ending now (like smoke-voice.js)
      const start = Date.now() - m.minutes * 60000;
      for (let i = 0; i <= m.minutes; i++) detector?.process(start + i * 60000, 0.0);
      return;
    }
    case "clip": {
      const p = pendingClips.get(m.id); pendingClips.delete(m.id);
      return m.error ? p?.reject(new Error(m.error)) : p?.resolve(Buffer.from(m.wav, "base64"));
    }
    case "stop": return teardown();
  }
}
send({ t: "boot" });
