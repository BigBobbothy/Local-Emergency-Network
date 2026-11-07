/**
 * qvac-helpers.js - connects the detector to QVAC (https://docs.qvac.tether.io), so the
 * check-in is SPOKEN by an on-device TTS model and, optionally, the user can answer
 * out loud ("I'm okay") and have it transcribed by an on-device ASR model.
 *
 * Like node-helpers.js this is OUTSIDE the portable core: inactivity.js never imports
 * it. `@qvac/sdk` is loaded lazily (or injected via `sdk`), so the rest of the project
 * and its tests run without it installed.
 *
 *   npm install @qvac/sdk
 *
 * WIRING
 *   const qvac = createQvac({ record });                       // record: see below
 *   await qvac.warmup();                                       // load models while idle
 *   const detector = new InactivityDetector(id, config,
 *     { actions: { ...defaultActions(), ...qvac.actions } });  // replaces the placeholder
 *   qvac.bind(detector);                                       // lets a spoken reply acknowledge
 *   ...
 *   await qvac.close();                                        // unload models
 *
 * PRIVACY / SAFETY DESIGN
 *  - Everything runs on-device; no audio or text leaves the machine through this file.
 *  - The microphone is only used while a check-in/alert is pending
 *    (`detector.awaitingResponse`) and for at most `listenMinutes`.
 *  - Clips are transcribed and discarded. Transcripts are never logged or stored; the
 *    only thing that survives is the yes/no outcome (an acknowledgement).
 *  - Fails safe: a reply only counts if it clearly says "I'm okay/fine/alright" with no
 *    negation or distress words. Anything unclear is ignored, so the escalation
 *    continues and the person is still checked on. A missed acknowledgement costs a
 *    contact a notification; a false one could suppress a real alert.
 *  - If speech synthesis fails, `fallback(event)` runs (e.g. a visual prompt). Even if
 *    nothing reaches the user, the grace period still ends in an alert.
 *
 * `record` (only needed for voice replies) is YOUR microphone capture:
 *    async ({ signal, seconds }) => clip
 *  where clip is a path to a 16 kHz mono WAV, a Buffer of one, or
 *  { audio: path|Buffer, cleanup?: () => void } (cleanup runs after transcription,
 *  e.g. to delete a temp file). Use whatever your platform offers (ffmpeg, sox,
 *  a native module). This file deliberately ships no recorder.
 */

const noop = () => {};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ wording
/** What the check-in says. Must NOT contain a phrase isAffirmative() accepts, or the
 *  speaker's own voice picked up by the mic could acknowledge the check-in. */
export function spokenCheckInText(event) {
  const mins = Math.max(1, Math.round(event?.inactiveMinutes ?? 0));
  let span;
  if (mins < 90) span = `${Math.round(mins / 5) * 5 || mins} minutes`;
  else {
    const h = Math.round(mins / 30) / 2; // nearest half hour
    span = `${h} hours`;
  }
  return `Hello. You have been still for about ${span}. Are you okay? Please answer out loud, or press the button.`;
}

const NEGATION = /\b(not|no|never|help|hurt|hurts|fell|fall|fallen|pain|cannot)\b|n't\b/;
const AFFIRM = [
  /\b(i'?m|im|i am)( still| really| completely| totally| quite)?\s+(ok|okay|fine|alright|all right|good|safe)\b/,
  /\ball good\b/,
];

/** Conservative: true only for a clear "I'm okay"-style reply with no negation. */
export function isAffirmative(transcript) {
  if (typeof transcript !== "string") return false;
  const t = transcript
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\./g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || NEGATION.test(t)) return false;
  return AFFIRM.some((re) => re.test(t));
}

// -------------------------------------------------------------------- audio
/** QVAC TTS returns raw mono signed-16-bit PCM samples (number[]); wrap them as WAV. */
export function wavFromPcm(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Default player: streams the WAV into ffplay (ships with ffmpeg; must be on PATH).
 *  Asynchronous, so sensor readings keep flowing while it speaks. */
// Desktop-only. Loaded lazily, through a computed specifier, so bundlers for Bare/phones
// (bare-pack) do not try to resolve node:child_process. On a phone pass your own `play`.
const NODE_CP = "node:child_" + "process";
export async function ffplayPlayer(wav) {
  const { spawn } = await import(NODE_CP);
  return new Promise((resolve, reject) => {
    const p = spawn("ffplay", ["-hide_banner", "-loglevel", "error", "-autoexit", "-nodisp", "-i", "pipe:0"], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error("ffplay not found on PATH (install ffmpeg)") : e));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffplay exited with code ${code}`))));
    p.stdin.on("error", () => {}); // early exit -> EPIPE; the close handler reports it
    p.stdin.end(wav);
  });
}

// --------------------------------------------------------------------- main
/**
 * options
 *   sdk              inject the QVAC module (tests / custom loading). Default: import("@qvac/sdk").
 *   ttsModelSrc      default: sdk.TTS_MULTILINGUAL_SUPERTONIC3_Q8_0
 *   ttsConfig        merged into modelConfig (default { ttsEngine: "supertonic", language: "en", voice: "F1" })
 *   asrModelSrc      default: sdk.PARAKEET_UNIFIED_0_6B_Q8_0 (English, ~740 MB; sdk.WHISPER_TINY is much smaller)
 *   asrModelType     default "parakeet-transcription" (use "whisper" with a Whisper model)
 *   asrConfig        modelConfig for the ASR model (optional)
 *   record           microphone capture (see top of file); without it there are no voice replies
 *   play             async (wavBuffer) => void; default ffplayPlayer
 *   text             (event) => string; default spokenCheckInText
 *   fallback         async (event) => void; runs if speaking fails
 *   isAffirmative    custom reply matcher (default: the conservative one above)
 *   clipSeconds      length of each recorded clip (default 5)
 *   listenMinutes    longest the mic stays open after a check-in (default 45)
 *   settleMs         pause after speaking before recording, so the mic does not hear the tail (default 800)
 *   logger           { info, warn, error } (default console)
 *   sleep            injectable for tests
 */
export function createQvac(options = {}) {
  const o = {
    clipSeconds: 5, listenMinutes: 45, settleMs: 800, text: spokenCheckInText,
    play: ffplayPlayer, isAffirmative, sleep: sleepMs, logger: console, ...options,
  };
  const log = { info: noop, warn: noop, error: noop, ...o.logger };

  let sdk = o.sdk ?? null;
  let detector = null;
  let ttsId = null, asrId = null;
  let ttsLoading = null, asrLoading = null;
  let current = null; // { ctl, done } for the check-in being handled
  let closed = false;

  async function getSdk() {
    if (sdk) return sdk;
    try {
      sdk = await import("@qvac/sdk");
    } catch (e) {
      if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") {
        throw new Error("QVAC SDK is not installed: run `npm install @qvac/sdk`");
      }
      throw e;
    }
    return sdk;
  }

  const progress = (what) => (p) => {
    if (p && Number.isFinite(p.percentage) && p.percentage >= 100) log.info(`QVAC ${what} model ready`);
  };

  function loadTts() {
    return (ttsLoading ??= (async () => {
      const s = await getSdk();
      const modelSrc = o.ttsModelSrc ?? s.TTS_MULTILINGUAL_SUPERTONIC3_Q8_0;
      if (!modelSrc) throw new Error("no TTS model: pass ttsModelSrc");
      ttsId = await s.loadModel({
        modelSrc,
        ...(o.ttsModelType ? { modelType: o.ttsModelType } : {}),
        modelConfig: { ttsEngine: "supertonic", language: "en", voice: "F1", ...(o.ttsConfig ?? {}) },
        onProgress: progress("speech"),
      });
      return ttsId;
    })().catch((e) => { ttsLoading = null; throw e; })); // allow a retry on the next check-in
  }

  function loadAsr() {
    return (asrLoading ??= (async () => {
      const s = await getSdk();
      const modelSrc = o.asrModelSrc ?? s.PARAKEET_UNIFIED_0_6B_Q8_0;
      if (!modelSrc) throw new Error("no ASR model: pass asrModelSrc");
      asrId = await s.loadModel({
        modelSrc,
        modelType: o.asrModelType ?? "parakeet-transcription",
        ...(o.asrConfig ? { modelConfig: o.asrConfig } : {}),
        onProgress: progress("transcription"),
      });
      return asrId;
    })().catch((e) => { asrLoading = null; throw e; }));
  }

  async function speak(text) {
    const s = await getSdk();
    const modelId = await loadTts();
    const result = s.textToSpeech({ modelId, text, inputType: "text", stream: false });
    const pcm = await result.buffer;
    const rate = (await result.sampleRate) ?? 44100;
    if (!pcm?.length) throw new Error("speech synthesis produced no audio");
    await o.play(wavFromPcm(pcm, rate));
  }

  async function transcribeClip(audio) {
    const s = await getSdk();
    const modelId = await loadAsr();
    return s.transcribe({ modelId, audioChunk: audio });
  }

  /** Listen for a spoken "I'm okay" while a response is pending. Resolves true if heard. */
  async function listen(signal) {
    if (!o.record || !detector) return false;
    const deadline = Date.now() + o.listenMinutes * 60000;
    while (!signal.aborted && Date.now() < deadline && detector.awaitingResponse) {
      let clip = null;
      try {
        clip = await o.record({ signal, seconds: o.clipSeconds });
        if (signal.aborted || !detector.awaitingResponse) return false;
        const audio = clip && typeof clip === "object" && !Buffer.isBuffer(clip) ? clip.audio : clip;
        const text = await transcribeClip(audio);
        if (o.isAffirmative(text)) { // transcript is dropped here, never logged
          log.info("voice acknowledgement heard");
          detector.acknowledge();
          return true;
        }
      } catch (e) {
        if (signal.aborted) return false;
        log.error(`QVAC listening step failed (${e?.name}); retrying`);
        await o.sleep(5000);
      } finally {
        try { clip?.cleanup?.(); } catch { /* ignore */ }
      }
    }
    return false;
  }

  /** Registry action for the check_in_requested event. Single-flight. */
  function checkInPrompt(event) {
    if (closed || current) return current?.done;
    const ctl = new AbortController();
    const done = (async () => {
      try {
        try {
          await speak(o.text(event));
        } catch (e) {
          log.error(`QVAC speech failed (${e?.name}); using fallback`);
          try { await o.fallback?.(event); } catch (e2) { log.error(`fallback failed (${e2?.name})`); }
        }
        if (o.record && !ctl.signal.aborted) {
          await o.sleep(o.settleMs);
          await listen(ctl.signal);
        }
      } finally {
        current = null;
      }
    })();
    current = { ctl, done };
    return done;
  }

  return {
    /** Spread into your action registry; replaces the placeholder check_in_prompt. */
    actions: { check_in_prompt: checkInPrompt },
    /** Give the adapter the detector so a spoken reply can acknowledge it. */
    bind(d) { detector = d; return this; },
    /** Load the models now (downloads on first run), so a check-in is never delayed. */
    async warmup() { await loadTts(); if (o.record) await loadAsr(); },
    /** Resolves when no check-in is being spoken/listened to (mainly for tests). */
    whenIdle() { return current?.done ?? Promise.resolve(); },
    /** Stop listening and unload models. Call sdk.close() yourself at process exit. */
    async close() {
      closed = true;
      current?.ctl.abort();
      await current?.done?.catch(noop);
      const s = sdk;
      for (const id of [ttsId, asrId]) {
        if (id && s) { try { await s.unloadModel({ modelId: id }); } catch (e) { log.error(`unload failed (${e?.name})`); } }
      }
      ttsId = asrId = ttsLoading = asrLoading = null;
    },
  };
}
