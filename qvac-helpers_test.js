// Run with:  node --test      (or: npm test)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventKind as K, InactivityDetector, defaultActions, makeConfig, setLogger } from "./inactivity.js";
import { createQvac, isAffirmative, spokenCheckInText, wavFromPcm } from "./qvac-helpers.js";

setLogger({ info() {}, warn() {}, error() {} });
const quiet = { info() {}, warn() {}, error() {} };

const MIN = 60000;
const T0 = Date.UTC(2024, 2, 4, 14, 0);
const kinds = (events) => events.map((e) => e.kind);

/** Fake @qvac/sdk: records calls, serves canned transcripts. */
function fakeSdk({ transcripts = [], ttsFails = false } = {}) {
  const calls = { load: [], tts: [], transcribe: [], unload: [] };
  const queue = [...transcripts];
  return {
    calls,
    TTS_MULTILINGUAL_SUPERTONIC3_Q8_0: "tts-const",
    PARAKEET_UNIFIED_0_6B_Q8_0: "asr-const",
    async loadModel(args) { calls.load.push(args); return `model-${calls.load.length}`; },
    textToSpeech(args) {
      calls.tts.push(args);
      if (ttsFails) throw new Error("synthesis exploded");
      return { buffer: Promise.resolve([0, 100, -100, 32767]), sampleRate: Promise.resolve(24000) };
    },
    async transcribe(args) { calls.transcribe.push(args); return queue.shift() ?? ""; },
    async unloadModel(args) { calls.unload.push(args); },
  };
}

/** Detector wired to QVAC; every action also records events. */
function wire(qvacOptions = {}, overrides = {}) {
  const events = [];
  const played = [];
  const qvac = createQvac({ sdk: fakeSdk(), logger: quiet, settleMs: 0, sleep: async () => {},
    play: async (wav) => { played.push(wav); }, ...qvacOptions });
  const actions = { ...defaultActions(), ...qvac.actions, record: (e) => events.push(e) };
  const recordAll = Object.fromEntries(Object.values(K).map((k) => [k, ["record"]]));
  recordAll[K.CHECK_IN_REQUESTED] = ["record", "check_in_prompt"];
  const det = new InactivityDetector("u", makeConfig({ defaultThresholdMinutes: 180, actions: recordAll, ...overrides }), { actions });
  qvac.bind(det);
  return { qvac, det, events, played };
}
function feed(det, start, minutes, value = 0.0) {
  let t = start;
  for (let i = 0; i < minutes; i++, t += MIN) det.process(t, value);
  return t;
}

describe("wording and reply matching", () => {
  it("speaks a short, calm, rounded prompt", () => {
    assert.match(spokenCheckInText({ inactiveMinutes: 180 }), /about 3 hours/);
    assert.match(spokenCheckInText({ inactiveMinutes: 200 }), /about 3.5 hours/);
    assert.match(spokenCheckInText({ inactiveMinutes: 62 }), /about 60 minutes/);
    assert.match(spokenCheckInText({}), /about 1 minutes|about 5 minutes|about 1 minute/);
  });

  it("accepts clear 'I'm okay' replies", () => {
    for (const ok of ["I'm okay", "I'm OK.", "Yes, I am fine", "im alright", "I\u2019m really good", "all good!", "I'm fine thanks"]) {
      assert.equal(isAffirmative(ok), true, ok);
    }
  });

  it("rejects negations, distress, and unrelated speech", () => {
    for (const bad of ["I'm not okay", "I'm not fine", "I can't get up, help", "I fell", "no", "yes", "",
      "the weather is good today", "are you okay", "I'm fine but I don't feel well", null, undefined, 42]) {
      assert.equal(isAffirmative(bad), false, String(bad));
    }
  });

  it("the spoken prompt can never acknowledge itself through the microphone", () => {
    for (const m of [10, 60, 180, 600]) assert.equal(isAffirmative(spokenCheckInText({ inactiveMinutes: m })), false);
  });

  it("wraps PCM as a mono 16-bit WAV", () => {
    const wav = wavFromPcm([0, 1, -1, 99999], 24000);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), 8); // 4 samples * 2 bytes
    assert.equal(wav.readInt16LE(44 + 6), 32767); // clipped
  });
});

describe("detector.awaitingResponse", () => {
  it("is true exactly between a check-in/alert and its resolution", () => {
    const { det } = wire();
    assert.equal(det.awaitingResponse, false);
    const end = feed(det, T0, 181); // check-in at 180
    assert.equal(det.awaitingResponse, true);
    det.acknowledge();
    assert.equal(det.awaitingResponse, false);
    det.process(end + 100 * MIN, 0.9);
    assert.equal(det.awaitingResponse, false);
  });

  it("goes false again when movement ends the run", () => {
    const { det } = wire();
    const end = feed(det, T0, 181);
    assert.equal(det.awaitingResponse, true);
    det.process(end, 0.9);
    assert.equal(det.awaitingResponse, false);
  });
});

describe("spoken check-in", () => {
  it("synthesises the prompt with QVAC TTS and plays it", async () => {
    const sdk = fakeSdk();
    const { qvac, det, played } = wire({ sdk });
    feed(det, T0, 181);
    await qvac.whenIdle();
    assert.equal(sdk.calls.tts.length, 1);
    assert.match(sdk.calls.tts[0].text, /Are you okay/);
    assert.equal(sdk.calls.tts[0].stream, false);
    assert.equal(sdk.calls.tts[0].modelId, "model-1");
    assert.equal(sdk.calls.load[0].modelSrc, "tts-const");
    assert.equal(sdk.calls.load[0].modelConfig.ttsEngine, "supertonic");
    assert.equal(played.length, 1);
    assert.equal(played[0].readUInt32LE(24), 24000); // uses the sample rate the engine reported
    assert.equal(sdk.calls.transcribe.length, 0); // no record function -> never listens
    assert.equal(sdk.calls.load.length, 1); // ASR model not even loaded
  });

  it("only speaks once per check-in even if triggered twice", async () => {
    const sdk = fakeSdk();
    const { qvac, det, events } = wire({ sdk });
    feed(det, T0, 181);
    qvac.actions.check_in_prompt(events[0]);
    await qvac.whenIdle();
    assert.equal(sdk.calls.tts.length, 1);
  });

  it("falls back when speech fails, and monitoring continues", async () => {
    const sdk = fakeSdk({ ttsFails: true });
    const seen = [];
    const { qvac, det, events } = wire({ sdk, fallback: async (e) => { seen.push(e.kind); } });
    feed(det, T0, 200); // past grace (15 min) -> alert still raised
    await qvac.whenIdle();
    assert.deepEqual(seen, [K.CHECK_IN_REQUESTED]);
    assert.ok(kinds(events).includes(K.ALERT_RAISED));
  });

  it("a failed model load can be retried on the next check-in", async () => {
    const sdk = fakeSdk();
    let first = true;
    const realLoad = sdk.loadModel.bind(sdk);
    sdk.loadModel = async (a) => { if (first) { first = false; throw new Error("disk full"); } return realLoad(a); };
    const { qvac } = wire({ sdk });
    await assert.rejects(qvac.warmup(), /disk full/);
    await qvac.warmup();
    assert.equal(sdk.calls.load.length, 1);
  });

  it("explains how to install the SDK if it is missing", async () => {
    const qvac = createQvac({ logger: quiet });
    await assert.rejects(qvac.warmup(), /npm install @qvac\/sdk/);
  });
});

describe("voice acknowledgement", () => {
  it("'I'm okay' acknowledges the check-in, so no alert is raised", async () => {
    const sdk = fakeSdk({ transcripts: ["I'm okay"] });
    const cleaned = [];
    const { qvac, det, events } = wire({
      sdk, asrConfig: undefined,
      record: async () => ({ audio: "/tmp/clip.wav", cleanup: () => cleaned.push(1) }),
    });
    const end = feed(det, T0, 181);
    await qvac.whenIdle();
    assert.deepEqual(kinds(events), [K.CHECK_IN_REQUESTED, K.ALERT_ACKNOWLEDGED]);
    assert.equal(sdk.calls.transcribe[0].audioChunk, "/tmp/clip.wav");
    assert.equal(sdk.calls.load[1].modelType, "parakeet-transcription");
    assert.equal(cleaned.length, 1);
    feed(det, end, 10); // snoozed, still within grace window of the old check-in
    assert.ok(!kinds(events).includes(K.ALERT_RAISED));
  });

  it("an unclear or negative reply does not acknowledge; the alert still follows", async () => {
    const sdk = fakeSdk({ transcripts: ["I'm not okay", "mumble", "thanks for asking"] });
    let n = 0;
    let t = T0 + 181 * MIN;
    const { qvac, det, events } = wire({
      sdk,
      record: async () => {
        n++;
        if (n === 4) det.process(t, 0.9); // end the episode so the loop can finish
        return Buffer.from("fake wav");
      },
    });
    const end = feed(det, T0, 181);
    // The reading stream keeps flowing while the adapter listens: grace expires.
    for (let i = 0; i < 20; i++) det.process(end + i * MIN, 0.0), t = end + (i + 1) * MIN;
    await qvac.whenIdle();
    assert.equal(sdk.calls.transcribe.length, 3); // all three replies heard and rejected
    assert.ok(!kinds(events).includes(K.ALERT_ACKNOWLEDGED));
    assert.ok(kinds(events).includes(K.ALERT_RAISED)); // escalation was never suppressed
  });

  it("stops listening as soon as the person moves", async () => {
    const sdk = fakeSdk({ transcripts: ["noise", "noise", "noise"] });
    let n = 0;
    let t = T0 + 181 * MIN;
    const { qvac, det, events } = wire({
      sdk,
      record: async () => {
        n++;
        if (n === 2) det.process(t, 0.9); // person gets up while we are listening
        return Buffer.from("fake wav");
      },
    });
    feed(det, T0, 181);
    await qvac.whenIdle();
    assert.equal(n, 2); // no third recording
    assert.equal(sdk.calls.transcribe.length, 1); // the clip recorded after movement is discarded unheard
    assert.ok(!kinds(events).includes(K.ALERT_ACKNOWLEDGED));
  });

  it("stops listening after listenMinutes", async () => {
    const sdk = fakeSdk({ transcripts: [] });
    let n = 0;
    const { qvac, det } = wire({ sdk, listenMinutes: 0, record: async () => { n++; return Buffer.from("x"); } });
    feed(det, T0, 181);
    await qvac.whenIdle();
    assert.equal(n, 0);
  });

  it("recording errors are survived and retried", async () => {
    const sdk = fakeSdk({ transcripts: ["I am fine"] });
    let n = 0;
    const { qvac, det, events } = wire({
      sdk,
      record: async () => { n++; if (n === 1) throw new Error("mic busy"); return Buffer.from("wav"); },
    });
    feed(det, T0, 181);
    await qvac.whenIdle();
    assert.equal(n, 2);
    assert.ok(kinds(events).includes(K.ALERT_ACKNOWLEDGED));
  });

  it("close() aborts listening and unloads the models", async () => {
    const sdk = fakeSdk();
    let started;
    const recording = new Promise((r) => (started = r));
    const { qvac, det } = wire({
      sdk,
      record: ({ signal }) => new Promise((_, rej) => { started(); signal.addEventListener("abort", () => rej(new Error("aborted"))); }),
    });
    feed(det, T0, 181);
    await recording;
    await qvac.close();
    assert.deepEqual(sdk.calls.unload.map((u) => u.modelId).sort(), ["model-1"]);
  });
});
