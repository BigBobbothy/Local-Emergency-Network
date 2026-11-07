import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { InactivityDetector, defaultActions, makeConfig } from "./inactivity.js";
import { createQvac } from "./qvac-helpers.js";

// Records `seconds` from your laptop mic and returns a 16 kHz mono WAV.
async function record({ signal, seconds }) {
  const file = join(tmpdir(), `clip-${Date.now()}.wav`);
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-loglevel", "error", "-f", "dshow",
      "-i", "audio=Microphone Array (Realtek(R) Audio)",
      "-t", String(seconds), "-ar", "16000", "-ac", "1", file,
    ], { signal });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  return { audio: file, cleanup: () => { try { unlinkSync(file); } catch {} } };
}

const qvac = createQvac({ record });
const events = [];
const actions = { ...defaultActions(), ...qvac.actions, log: (e) => events.push(e.kind) };
const detector = new InactivityDetector("test", makeConfig({ defaultThresholdMinutes: 60 }), { actions });
qvac.bind(detector);

await qvac.warmup();

// 61 minutes of stillness triggers the check-in
const start = Date.now() - 61 * 60000;
for (let i = 0; i < 62; i++) detector.process(start + i * 60000, 0.0);

await qvac.whenIdle();
console.log(events); // expect check_in_requested then alert_acknowledged
await qvac.close();