/**
 * live-example.js - the detector wired to QVAC for real use (Node).
 *   npm install            (pulls the optional @qvac/sdk)
 *   node live-example.js
 *
 * Two CONNECT points remain, because they depend on your hardware:
 *   liveSensorSource()  (inactivity.js)  your sensor / wearable feed
 *   record()            below            your microphone capture (needed only for voice replies)
 */
import { BaselineModel, InactivityDetector, defaultActions, makeConfig, runMonitor, liveSensorSource } from "./inactivity.js";
import { FileStorage } from "./node-helpers.js";
import { createQvac } from "./qvac-helpers.js";

// CONNECT: record ~`seconds` of microphone audio and return a 16 kHz mono WAV
// (path, Buffer, or { audio, cleanup }). Remove `record` below to speak only.
async function record({ signal, seconds }) {
  throw new Error("CONNECT: implement record() for your platform");
}

const config = makeConfig({ timezone: "Europe/London" });
const qvac = createQvac({
  record,
  fallback: async (event) => console.warn("[fallback] show a visual check-in instead", event.kind),
});
const detector = new InactivityDetector("pseudonymous-id", config, {
  baseline: new BaselineModel(config, new FileStorage("./state/baseline.json")),
  actions: { ...defaultActions(), ...qvac.actions }, // QVAC replaces the check-in placeholder
});
qvac.bind(detector);

await qvac.warmup(); // downloads models on first run; afterwards works offline
const timer = setInterval(() => detector.tick(), 60_000); // notices a silent sensor
try {
  await runMonitor(liveSensorSource(), detector, { clock: () => Date.now(), maxRetries: 5 });
} finally {
  clearInterval(timer);
  await qvac.close();
}
