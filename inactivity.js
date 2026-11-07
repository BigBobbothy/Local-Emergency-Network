/**
 * inactivity.js - personalised detection of unusually prolonged inactivity.
 *
 * JavaScript port of the Python prototype (inactivity_monitor.py).
 *
 * PORTABLE CORE: this file has NO imports, so it runs unchanged in Node 18+, browsers,
 * React Native and Bare (the runtime under Pear). Anything that touches the file
 * system or the network lives in node-helpers.js or is supplied by you (storage,
 * actions, sensor source).
 *
 * HOW IT WORKS
 * ------------
 * 1. A source yields [timestamp, activity] readings. Activity is any non-negative
 *    movement-intensity number; below `motionThreshold` counts as "still".
 * 2. Consecutive still readings form a *still run*. Movement ends the run.
 * 3. A run that ends normally is added to a per-user baseline, kept per time-of-day
 *    bucket (default: one per hour, by the hour the run STARTED).
 * 4. Threshold for a bucket = clamp(P90 of recent runs * multiplier, min, max).
 *    Buckets with fewer than `minRunsForBaseline` runs use a lenient default (12 h).
 * 5. When a run passes its threshold:
 *        threshold reached      -> check-in request (soft prompt to the user)
 *        + grace, no response   -> alert (notify the user's chosen contacts)
 *        still unacknowledged   -> reminders (capped)
 *    `detector.acknowledge()` cancels the escalation and snoozes it.
 *
 * FALSE-ALARM SAFEGUARDS: grace period; data-gap check (a gap restarts the timer and
 * emits `data_gap`, never an inactivity alert); invalid / duplicate / out-of-order
 * readings are dropped and counted; the baseline never learns from runs broken by
 * gaps or from runs that ended an unacknowledged alert, clips each new run to
 * `maxUpdateRatio` x the reference, and expires data after `baselineWindowDays`.
 *
 * PRIVACY: raw readings are processed in memory and never stored or logged. Only
 * [dayNumber, minutes] pairs per bucket are kept (optionally via a storage adapter you
 * control). `baseline.forget()` erases them. Use a pseudonymous userId.
 *
 * ASSUMPTIONS
 *  - The sensor sends periodic readings (heartbeat) even when nothing moves.
 *  - Timestamps: Date objects, ISO-8601 strings, or numbers = epoch MILLISECONDS.
 *    ISO strings without a zone designator are treated as UTC.
 *  - Runs are bucketed by their start hour, so thresholds are lenient around bedtime
 *    (sleep looks like inactivity). Screening aid, not a medical device.
 *  - NEVER contacts emergency services, by design.
 *
 * CONNECT: points you must wire to real systems
 *  - liveSensorSource()        real sensor / wearable feed
 *  - notifyPlaceholder         alert to the user's chosen contacts (e.g. over Pear)
 *  - checkInPromptPlaceholder  spoken/visual check-in (e.g. QVAC text-to-speech)
 *  - acknowledgement channel   button / voice reply -> detector.acknowledge()
 *
 * Actions may be async (return a Promise); failures are caught and logged.
 */

const MINUTE = 60000;
const DAY = 86400000;

// ------------------------------------------------------------------ logging
let logger = {
  debug() {},
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};
/** Replace any of debug/info/warn/error, e.g. setLogger({ info() {} }) to silence. */
export function setLogger(overrides) {
  logger = { ...logger, ...overrides };
}

// ------------------------------------------------------------------- errors
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}
export class SensorError extends Error {
  constructor(message) { super(message); this.name = "SensorError"; }
}
class InvalidReading extends Error {} // message never contains the raw value

// ------------------------------------------------------------------- events
export const EventKind = Object.freeze({
  CHECK_IN_REQUESTED: "check_in_requested",
  ALERT_RAISED: "alert_raised",
  ALERT_REMINDER: "alert_reminder",
  ALERT_ACKNOWLEDGED: "alert_acknowledged",
  ALERT_CLEARED: "alert_cleared", // movement resumed while an alert was open
  DATA_GAP: "data_gap", // sensor/data interruption (NOT an inactivity alert)
});

/** Event timestamps are epoch milliseconds (UTC). */
export function eventToDict(e) {
  const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    kind: e.kind,
    timestamp: new Date(e.timestamp).toISOString(),
    userId: e.userId,
    inactiveMinutes: r(e.inactiveMinutes),
    thresholdMinutes: r(e.thresholdMinutes),
    note: e.note,
  };
}

// ------------------------------------------------------------------- config
/** Which named actions run for which event. Names refer to the action registry. */
export const DEFAULT_ACTION_MAP = Object.freeze({
  check_in_requested: ["log", "check_in_prompt"],
  alert_raised: ["log", "notify"],
  alert_reminder: ["log", "notify"],
  alert_acknowledged: ["log"],
  alert_cleared: ["log", "notify"],
  data_gap: ["log"],
});

const DEFAULTS = Object.freeze({
  motionThreshold: 0.05, // activity < this counts as "still"
  maxGapSeconds: 300, // no valid reading for longer = data gap
  timezone: "UTC", // for time-of-day buckets
  bucketHours: 1, // must divide 24
  baselineWindowDays: 14,
  baselinePercentile: 90,
  minRunsForBaseline: 5,
  minRunMinutes: 5, // shorter runs are noise
  maxBaselineRunMinutes: 14 * 60, // longer runs are never learned
  maxUpdateRatio: 1.5, // a new run counts for at most 1.5x the reference
  maxRunsPerBucket: 200,
  thresholdMultiplier: 1.5,
  minThresholdMinutes: 60,
  maxThresholdMinutes: 12 * 60,
  defaultThresholdMinutes: 12 * 60, // lenient until a bucket has history
  gracePeriodMinutes: 15, // check-in -> alert delay (0 = immediately)
  renotifyIntervalMinutes: 30,
  maxAlertsPerEpisode: 3,
  ackSnoozeMinutes: 60,
});

function need(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

/** Build and validate a config. Unknown keys and bad values throw ConfigError. */
export function makeConfig(overrides = {}) {
  for (const k of Object.keys(overrides)) {
    need(k === "actions" || k === "timezone" || k in DEFAULTS, `unknown config option: ${k}`);
  }
  const c = { ...DEFAULTS, ...overrides, actions: { ...DEFAULT_ACTION_MAP, ...(overrides.actions ?? {}) } };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (k !== "timezone") need(typeof c[k] === "number" && Number.isFinite(c[k]), `${k} must be a finite number`);
  }
  need(c.motionThreshold >= 0, "motionThreshold must be >= 0");
  need(c.maxGapSeconds > 0, "maxGapSeconds must be > 0");
  need(Number.isInteger(c.bucketHours) && c.bucketHours >= 1 && 24 % c.bucketHours === 0, "bucketHours must divide 24");
  need(c.baselineWindowDays >= 1, "baselineWindowDays must be >= 1");
  need(c.baselinePercentile > 0 && c.baselinePercentile <= 100, "baselinePercentile must be in (0, 100]");
  need(c.minRunsForBaseline >= 1, "minRunsForBaseline must be >= 1");
  need(c.minRunMinutes >= 0, "minRunMinutes must be >= 0");
  need(c.maxBaselineRunMinutes > c.minRunMinutes, "maxBaselineRunMinutes too small");
  need(c.maxUpdateRatio >= 1, "maxUpdateRatio must be >= 1");
  need(c.maxRunsPerBucket >= c.minRunsForBaseline, "maxRunsPerBucket too small");
  need(c.thresholdMultiplier >= 1, "thresholdMultiplier must be >= 1");
  need(c.minThresholdMinutes > 0 && c.minThresholdMinutes <= c.maxThresholdMinutes, "need 0 < min <= max threshold");
  need(
    c.minThresholdMinutes <= c.defaultThresholdMinutes && c.defaultThresholdMinutes <= c.maxThresholdMinutes,
    "defaultThresholdMinutes must lie between min and max threshold",
  );
  need(c.gracePeriodMinutes >= 0, "gracePeriodMinutes must be >= 0");
  need(c.renotifyIntervalMinutes > 0, "renotifyIntervalMinutes must be > 0");
  need(c.maxAlertsPerEpisode >= 1, "maxAlertsPerEpisode must be >= 1");
  need(c.ackSnoozeMinutes >= 0, "ackSnoozeMinutes must be >= 0");
  need(typeof c.timezone === "string" && c.timezone, "timezone must be a string");
  const kinds = new Set(Object.values(EventKind));
  for (const [kind, names] of Object.entries(c.actions)) {
    need(kinds.has(kind), `unknown event kind in actions: ${kind}`);
    need(Array.isArray(names) && names.every((n) => typeof n === "string"), `actions.${kind} must be an array of names`);
  }
  return Object.freeze(c);
}

// -------------------------------------------------------- time and parsing
/**
 * Returns ms -> { hour, day } in the given IANA timezone.
 * Uses Intl; if your runtime lacks it (e.g. Bare), use "UTC" or pass `localClock`
 * to InactivityDetector.
 */
export function makeLocalClock(timezone) {
  if (String(timezone).toUpperCase() === "UTC") {
    return (ms) => {
      const day = Math.floor(ms / DAY);
      return { hour: Math.floor((ms - day * DAY) / 3600000), day };
    };
  }
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    });
  } catch {
    throw new ConfigError(`Unknown timezone '${timezone}' (or Intl unavailable: use "UTC" or pass localClock)`);
  }
  return (ms) => {
    const p = {};
    for (const { type, value } of fmt.formatToParts(ms)) p[type] = value;
    return { hour: Number(p.hour) % 24, day: Math.floor(Date.UTC(+p.year, +p.month - 1, +p.day) / DAY) };
  };
}

function parseTimestamp(raw) {
  let ms;
  if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](.*))?$/);
    if (!m) throw new InvalidReading("unparseable timestamp");
    let time = m[2] ?? "00:00:00";
    if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(time)) time += "Z"; // no zone given -> UTC
    ms = Date.parse(`${m[1]}T${time}`);
  } else if (typeof raw === "number") {
    ms = raw; // epoch milliseconds
  } else {
    throw new InvalidReading("unsupported timestamp type");
  }
  if (!Number.isFinite(ms)) throw new InvalidReading("invalid timestamp");
  return ms;
}

function parseActivity(raw) {
  if (raw === null || raw === undefined || typeof raw === "boolean") throw new InvalidReading("missing activity value");
  let v;
  if (typeof raw === "number") v = raw;
  else if (typeof raw === "string" && raw.trim() !== "") v = Number(raw);
  else throw new InvalidReading("non-numeric activity value");
  if (!Number.isFinite(v)) throw new InvalidReading("non-finite activity value");
  if (v < 0) throw new InvalidReading("negative activity value");
  return v;
}

// ------------------------------------------------------------------ sources
/**
 * A source is any iterable or async iterable yielding [timestamp, activity] pairs.
 * Yield malformed values as-is (the detector validates). Throw SensorError if the
 * source itself fails.
 */

/** Deterministic fake data. Asleep 23:00-07:00, otherwise alternating active (5-20 min)
 *  and still (10-60 min) spells; then normal until `scenarioHour` on the day after
 *  `days`, then `trailingStillMinutes` of complete stillness (the "incident"). */
export function simulatedSource({
  start = Date.UTC(2024, 0, 1), days = 14, intervalSeconds = 60,
  trailingStillMinutes = 0, scenarioHour = 14, seed = 42,
} = {}) {
  return {
    *[Symbol.iterator]() {
      let a = seed >>> 0; // mulberry32 PRNG: small, deterministic, seedable
      const rand = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const uniform = (lo, hi) => lo + rand() * (hi - lo);
      const randint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
      const step = intervalSeconds * 1000;
      let t = start;
      const normalEnd = start + days * DAY + scenarioHour * 3600000;
      let segEnd = t;
      let segActive = false;
      while (t < normalEnd) {
        const hour = new Date(t).getUTCHours();
        let value;
        if (hour >= 23 || hour < 7) {
          value = uniform(0, 0.02); segEnd = t; segActive = false;
        } else {
          if (t >= segEnd) {
            segActive = !segActive;
            segEnd = t + (segActive ? randint(5, 20) : randint(10, 60)) * MINUTE;
          }
          value = segActive ? uniform(0.2, 1.0) : uniform(0, 0.02);
        }
        yield [t, value];
        t += step;
      }
      if (trailingStillMinutes > 0) {
        yield [t, 0.5]; // last movement before the incident
        t += step;
        const end = t + trailingStillMinutes * MINUTE;
        while (t < end) { yield [t, uniform(0, 0.02)]; t += step; }
      }
    },
  };
}

/**
 * CONNECT: replace with your real sensor / wearable feed.
 * Contract: an async iterable yielding [timestamp, activity] about once a minute,
 * including when nothing moves. Reconnect inside if you can; throw SensorError if the
 * device is gone for good. Do NOT store raw readings anywhere.
 */
export function liveSensorSource() {
  return {
    [Symbol.asyncIterator]() {
      throw new SensorError("CONNECT: implement liveSensorSource() for your hardware or API.");
    },
  };
}

// ----------------------------------------------------------------- baseline
function percentile(sorted, pct) {
  if (sorted.length === 1) return sorted[0];
  const rank = ((sorted.length - 1) * pct) / 100;
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * Per-user, per-time-of-day record of recent still-run lengths. Stores ONLY
 * [dayNumber, minutes] per bucket.
 *
 * `storage` (optional) is any object with synchronous load() -> string|null,
 * save(text), remove(). See FileStorage in node-helpers.js; in a Pear app, wrap your
 * own storage the same way.
 */
export class BaselineModel {
  constructor(config, storage = null) {
    this._cfg = config;
    this._storage = storage;
    this._runs = new Map();
    if (storage) this._load();
  }

  runCount(bucket) {
    if (bucket !== undefined) return (this._runs.get(bucket) ?? []).length;
    let n = 0;
    for (const r of this._runs.values()) n += r.length;
    return n;
  }

  referenceMinutes(bucket) {
    const runs = this._runs.get(bucket) ?? [];
    if (runs.length < this._cfg.minRunsForBaseline) return null;
    return percentile(runs.map((r) => r[1]).sort((x, y) => x - y), this._cfg.baselinePercentile);
  }

  thresholdMinutes(bucket) {
    const c = this._cfg;
    const ref = this.referenceMinutes(bucket);
    if (ref === null) return c.defaultThresholdMinutes;
    return Math.min(Math.max(ref * c.thresholdMultiplier, c.minThresholdMinutes), c.maxThresholdMinutes);
  }

  /** Learn one completed run. Returns the stored value, or null if rejected. */
  addRun(bucket, minutes, day) {
    const c = this._cfg;
    if (!Number.isFinite(minutes) || minutes < c.minRunMinutes) return null;
    if (minutes > c.maxBaselineRunMinutes) { logger.info("Run too long to learn from; ignored"); return null; }
    const ref = this.referenceMinutes(bucket);
    if (ref !== null) minutes = Math.min(minutes, ref * c.maxUpdateRatio); // drift, never jump
    let runs = this._runs.get(bucket);
    if (!runs) this._runs.set(bucket, (runs = []));
    runs.push([day, minutes]);
    if (runs.length > c.maxRunsPerBucket) runs.splice(0, runs.length - c.maxRunsPerBucket);
    this.prune(day);
    this._save();
    return minutes;
  }

  /** Forget runs older than the baseline window (data minimisation). */
  prune(today) {
    const cutoff = today - this._cfg.baselineWindowDays;
    for (const [bucket, runs] of [...this._runs]) {
      const kept = runs.filter((r) => r[0] >= cutoff);
      if (kept.length) this._runs.set(bucket, kept);
      else this._runs.delete(bucket);
    }
  }

  /** Erase everything learned about this user, in memory and in storage. */
  forget() {
    this._runs.clear();
    if (this._storage) {
      try { this._storage.remove(); } catch (e) { logger.error(`Could not delete baseline (${e.name})`); }
    }
  }

  _save() {
    if (!this._storage) return;
    const runs = {};
    for (const [b, list] of this._runs) runs[b] = list.map(([d, m]) => [d, Math.round(m * 10) / 10]);
    try {
      this._storage.save(JSON.stringify({ version: 1, bucketHours: this._cfg.bucketHours, runs }));
    } catch (e) {
      logger.error(`Could not save baseline (${e.name}); continuing in memory`);
    }
  }

  _load() {
    try {
      const text = this._storage.load();
      if (text === null || text === undefined) return;
      const data = JSON.parse(text);
      if (data.version !== 1 || data.bucketHours !== this._cfg.bucketHours) throw new Error("incompatible baseline");
      const maxBucket = 24 / this._cfg.bucketHours;
      const loaded = new Map();
      for (const [key, list] of Object.entries(data.runs)) {
        const bucket = Number(key);
        if (!Number.isInteger(bucket) || bucket < 0 || bucket >= maxBucket) throw new Error("bucket out of range");
        loaded.set(bucket, list.map(([d, m]) => {
          if (!Number.isInteger(d) || !Number.isFinite(m) || m < 0) throw new Error("bad run");
          return [d, m];
        }));
      }
      this._runs = loaded;
    } catch (e) {
      logger.warn(`Ignoring unreadable baseline (${e.name}); starting fresh`);
      this._runs = new Map();
    }
  }
}

// ------------------------------------------------------------------ actions
export function logAction(event) {
  const alert = event.kind === EventKind.ALERT_RAISED || event.kind === EventKind.ALERT_REMINDER;
  logger[alert ? "warn" : "info"]("event=" + JSON.stringify(eventToDict(event)));
}

/** CONNECT: ask the USER if they are okay (e.g. QVAC text-to-speech or a phone prompt).
 *  Their answer should call detector.acknowledge(). */
export function checkInPromptPlaceholder(event) {
  logger.info(`[PLACEHOLDER] would ask the user 'Are you okay?' (inactive ${Math.round(event.inactiveMinutes ?? 0)} min)`);
}

/** CONNECT: notify the people the user chose (e.g. directly over a Pear peer-to-peer
 *  link). Keep it minimal: what happened and when, no raw data.
 *  Deliberately does NOT contact emergency services. */
export function notifyPlaceholder(event) {
  logger.warn("[PLACEHOLDER] would notify the user's contacts: " + JSON.stringify(eventToDict(event)));
}

/** The action registry: name -> function (may be async). Add or replace entries freely. */
export function defaultActions() {
  return { log: logAction, check_in_prompt: checkInPromptPlaceholder, notify: notifyPlaceholder };
}

// ----------------------------------------------------------------- detector
/**
 * Feed readings with process(); call tick() periodically in live use so a silent
 * sensor is noticed; call acknowledge() when the user/caregiver responds.
 * Each method returns the events it generated (also dispatched to actions).
 */
export class InactivityDetector {
  constructor(userId, config = {}, { baseline, actions, localClock } = {}) {
    if (typeof userId !== "string" || !userId) throw new ConfigError("userId must be a non-empty string (use a pseudonymous ID)");
    this.userId = userId;
    this.config = makeConfig(config);
    this._local = localClock ?? makeLocalClock(this.config.timezone);
    this.baseline = baseline ?? new BaselineModel(this.config);
    this._actions = actions ?? defaultActions(); // kept by reference: register more later if you like
    for (const [kind, names] of Object.entries(this.config.actions)) {
      for (const name of names) {
        if (typeof this._actions[name] !== "function") {
          throw new ConfigError(`action '${name}' (used for '${kind}') is not in the action registry`);
        }
      }
    }
    // Aggregate counters only: nothing personal.
    this.stats = { readingsOk: 0, readingsInvalid: 0, readingsOutOfOrder: 0, gaps: 0 };
    this._lastTs = null;
    this._lastDay = null;
    this._gapReported = false;
    this._resetRun();
  }

  /** Handle one reading. Never throws on bad data. */
  process(rawTimestamp, rawActivity) {
    let ts, value;
    try {
      ts = parseTimestamp(rawTimestamp);
      value = parseActivity(rawActivity);
    } catch (e) {
      if (!(e instanceof InvalidReading)) throw e;
      this.stats.readingsInvalid++;
      logger.debug(`Dropped invalid reading: ${e.message}`);
      return [];
    }
    const events = [];
    if (this._lastTs !== null) {
      if (ts <= this._lastTs) { this.stats.readingsOutOfOrder++; return []; }
      const gap = (ts - this._lastTs) / 1000;
      if (gap > this.config.maxGapSeconds) events.push(...this._onGap(ts, gap));
    }
    this.stats.readingsOk++;
    this._lastTs = ts;
    this._gapReported = false;

    const day = this._local(ts).day;
    if (day !== this._lastDay) { this._lastDay = day; this.baseline.prune(day); }

    events.push(...(value >= this.config.motionThreshold ? this._onMovement(ts) : this._onStill(ts)));
    this._dispatch(events);
    return events;
  }

  /** Call regularly (e.g. every minute) in live use: detects a sensor that went silent,
   *  which process() alone cannot see because it only runs on new readings. */
  tick(now) {
    if (this._lastTs === null) return [];
    const nowMs = now === undefined ? Date.now() : this._coerceNow(now);
    const gap = (nowMs - this._lastTs) / 1000;
    let events = [];
    if (gap > this.config.maxGapSeconds && !this._gapReported) events = this._onGap(nowMs, gap);
    this._dispatch(events);
    return events;
  }

  /** True while a check-in or alert is waiting for a response, i.e. exactly when
   *  acknowledge() would do something. Lets a voice/mic listener stay off otherwise. */
  get awaitingResponse() {
    return this._runStart !== null && (this._checkInSent || this._alertSent);
  }

  /** The user (or caregiver) says "I'm fine" / cancels. Valid after a check-in or alert.
   *  Stops the escalation and snoozes it for ackSnoozeMinutes; if the person is still
   *  inactive afterwards, the cycle starts again. */
  acknowledge(now) {
    if (this._runStart === null || !(this._checkInSent || this._alertSent)) {
      logger.info("acknowledge() called but nothing is pending");
      return [];
    }
    let nowMs = now === undefined ? (this._lastTs ?? Date.now()) : this._coerceNow(now);
    if (this._lastTs !== null) nowMs = Math.max(nowMs, this._lastTs);
    const minutes = (nowMs - this._runStart) / MINUTE;
    const event = this._event(EventKind.ALERT_ACKNOWLEDGED, nowMs, minutes, this._threshold(), "acknowledged by user");
    this._resetEscalation();
    this._suppressUntil = nowMs + this.config.ackSnoozeMinutes * MINUTE;
    this._dispatch([event]);
    return [event];
  }

  // ---- internals
  _coerceNow(now) {
    try { return parseTimestamp(now); } catch { throw new TypeError("invalid 'now'"); }
  }
  _bucket(ts) { return Math.floor(this._local(ts).hour / this.config.bucketHours); }
  _threshold() { return this.baseline.thresholdMinutes(this._runBucket); }
  _event(kind, timestamp, inactiveMinutes = null, thresholdMinutes = null, note = "") {
    return Object.freeze({ kind, timestamp, userId: this.userId, inactiveMinutes, thresholdMinutes, note });
  }

  _resetEscalation() {
    this._checkInSent = false; this._checkInTs = null;
    this._alertSent = false; this._alertOpen = false;
    this._alertCount = 0; this._lastAlertTs = null;
  }
  _resetRun() {
    this._runStart = null; this._runBucket = 0; this._suppressUntil = null;
    this._resetEscalation();
  }

  _onGap(ts, gapSeconds) {
    const events = [];
    if (!this._gapReported) {
      this.stats.gaps++;
      this._gapReported = true;
      events.push(this._event(EventKind.DATA_GAP, ts, null, null,
        `no valid readings for ${Math.round(gapSeconds / 60)} minutes; inactivity timer restarted`));
    }
    // We cannot know what happened during the gap, so the still run restarts (no false
    // alarm from stitched-together data). An alert that is already open stays open.
    if (!this._alertOpen) this._resetRun();
    return events;
  }

  _onMovement(ts) {
    const events = [];
    if (this._runStart !== null) {
      const minutes = (ts - this._runStart) / MINUTE;
      if (this._alertOpen) {
        events.push(this._event(EventKind.ALERT_CLEARED, ts, minutes, this._threshold(), "movement detected; alert closed"));
      } else { // never learn from a run that ended an unacknowledged alert
        this.baseline.addRun(this._runBucket, minutes, this._local(ts).day);
      }
      this._resetRun();
    }
    return events;
  }

  _onStill(ts) {
    if (this._runStart === null) { this._runStart = ts; this._runBucket = this._bucket(ts); }
    if (this._suppressUntil !== null && ts < this._suppressUntil) return []; // snoozed
    return this._escalate(ts);
  }

  _escalate(ts) {
    const c = this.config;
    const events = [];
    const minutes = (ts - this._runStart) / MINUTE;
    const threshold = this._threshold();

    if (minutes >= threshold && !this._checkInSent) {
      this._checkInSent = true; this._checkInTs = ts;
      events.push(this._event(EventKind.CHECK_IN_REQUESTED, ts, minutes, threshold,
        "inactivity exceeds personal threshold; asking user to check in"));
    }
    if (this._checkInSent && this._checkInTs !== null) {
      const graceOver = (ts - this._checkInTs) / MINUTE >= c.gracePeriodMinutes;
      if (graceOver && !this._alertSent) {
        this._alertSent = this._alertOpen = true;
        this._alertCount = 1; this._lastAlertTs = ts;
        events.push(this._event(EventKind.ALERT_RAISED, ts, minutes, threshold, "no response to check-in within grace period"));
      } else if (this._alertOpen && this._alertCount < c.maxAlertsPerEpisode && this._lastAlertTs !== null &&
                 (ts - this._lastAlertTs) / MINUTE >= c.renotifyIntervalMinutes) {
        this._alertCount++; this._lastAlertTs = ts;
        events.push(this._event(EventKind.ALERT_REMINDER, ts, minutes, threshold,
          `alert still unacknowledged (reminder ${this._alertCount - 1})`));
      }
    }
    return events;
  }

  _dispatch(events) {
    for (const event of events) {
      for (const name of this.config.actions[event.kind] ?? []) {
        const fn = this._actions[name];
        if (typeof fn !== "function") { logger.error(`Action '${name}' is not registered; skipped`); continue; }
        try {
          const result = fn(event);
          if (result && typeof result.then === "function") { // async action (e.g. TTS, network)
            result.catch((e) => logger.error(`Action '${name}' failed for ${event.kind} (${e?.name}); continuing`));
          }
        } catch (e) { // a broken notifier must never stop monitoring
          logger.error(`Action '${name}' failed for ${event.kind} (${e?.name}); continuing`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------- runner
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pump readings from `source` into `detector`. Resolves true if the source finished
 * cleanly, false if it failed for good. Never rejects on sensor problems.
 *
 * options.ackCheck   () => boolean, called before each reading; true acknowledges the
 *                    pending check-in/alert. CONNECT: wire to a button/voice reply
 *                    (node-helpers.js has fileAckCheck for a simple file-based one).
 * options.clock      live use: () => epoch ms. On a sensor error the detector is
 *                    ticked with it so the silence is reported.
 * options.maxRetries / retryDelayMs / sleep   reconnect behaviour (default: no retry).
 */
export async function runMonitor(source, detector, { ackCheck, clock, maxRetries = 0, retryDelayMs = 5000, sleep = sleepMs } = {}) {
  let attempts = 0;
  for (;;) {
    let fromSource = true; // only source failures are "sensor errors"; our own bugs must surface
    try {
      const it = typeof source[Symbol.asyncIterator] === "function" ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
      for (;;) {
        fromSource = true;
        const { value, done } = await it.next();
        fromSource = false;
        if (done) return true;
        if (ackCheck && ackCheck()) detector.acknowledge();
        detector.process(value?.[0], value?.[1]);
      }
    } catch (err) {
      if (!fromSource) throw err;
      attempts++;
      logger.error(`Sensor source error (attempt ${attempts} of ${maxRetries + 1}): ${err?.message ?? err?.name}`);
      if (clock) detector.tick(clock());
      if (attempts > maxRetries) return false;
      await sleep(retryDelayMs);
    }
  }
}
