import { createQvac } from "./qvac-helpers.js";

const qvac = createQvac({ record: async () => "./im-okay.wav", settleMs: 0 });;
await qvac.warmup();
await qvac.actions.check_in_prompt({ inactiveMinutes: 190 });
await qvac.close();
