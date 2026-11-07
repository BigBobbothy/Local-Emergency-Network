/**
 * src/GuardianScreen.tsx - the whole GUI. Drop it into the hello-pear-react-native template
 * and render <GuardianScreen /> from App.tsx.
 *
 * The screen owns what only a phone can do (speaker, microphone, motion sensor, TTS fallback);
 * the worker owns the logic. See worker/guardian.js for the message protocol.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, ScrollView, Switch, PermissionsAndroid, Platform, StyleSheet,
} from "react-native";
import { Worklet } from "react-native-bare-kit";
import b4a from "b4a";
import * as Speech from "expo-speech";
import { createAudioPlayer } from "expo-audio";
import { Accelerometer } from "expo-sensors";
import { Asset } from "expo-asset";
import * as FS from "expo-file-system/legacy";
import AudioRecord from "react-native-audio-record";
// Produced by `npm run bundle:guardian` (see SETUP.md)
// @ts-ignore
import guardianBundle from "./guardian.bundle.js";

type Role = "wearer" | "contact";
const b64 = { enc: FS.EncodingType.Base64 };

export default function GuardianScreen() {
  const [role, setRole] = useState<Role>("wearer");
  const [secret, setSecret] = useState("change-me-to-something-long-and-private");
  const [running, setRunning] = useState(false);
  const [peers, setPeers] = useState(0);
  const [awaiting, setAwaiting] = useState(false);
  const [useSensor, setUseSensor] = useState(false);
  const [fakeMic, setFakeMic] = useState(false); // answer with the bundled im-okay.wav
  const [alertBanner, setAlertBanner] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const worklet = useRef<any>(null);
  const ipc = useRef<any>(null);
  const fakeMicRef = useRef(false);
  fakeMicRef.current = fakeMic;

  const add = useCallback((s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 80)), []);
  const send = (m: object) => ipc.current?.write(JSON.stringify(m) + "\n");

  // ---------- phone-side capabilities the worker asks for
  async function playWav(wavB64: string) {
    const uri = FS.cacheDirectory + `say-${Date.now()}.wav`;
    await FS.writeAsStringAsync(uri, wavB64, b64);
    createAudioPlayer({ uri }).play();
  }
  async function recordClip(id: number, seconds: number) {
    try {
      let wav: string;
      if (fakeMicRef.current) { // test mode: no mic needed
        const a = Asset.fromModule(require("../assets/im-okay.wav"));
        await a.downloadAsync();
        wav = await FS.readAsStringAsync(a.localUri!, b64);
      } else {
        AudioRecord.init({ sampleRate: 16000, channels: 1, bitsPerSample: 16, audioSource: 6, wavFile: "clip.wav" });
        AudioRecord.start();
        await new Promise((r) => setTimeout(r, seconds * 1000));
        wav = await FS.readAsStringAsync("file://" + (await AudioRecord.stop()), b64);
      }
      send({ t: "clip", id, wav });
    } catch (e: any) {
      send({ t: "clip", id, error: String(e?.message ?? e) });
    }
  }

  function onMessage(m: any) {
    switch (m.t) {
      case "log": return add(`[${m.level}] ${m.m}`);
      case "ready": return add(`ready as ${m.role}`);
      case "peers": return setPeers(m.n);
      case "event": setAwaiting(!!m.awaiting); return add(`${m.e.kind} (${m.e.inactiveMinutes ?? "-"} min)`);
      case "remote": setAlertBanner(`${m.e.kind} at ${new Date(m.e.timestamp).toLocaleTimeString()}`); return add(`FROM PEER: ${m.e.kind}`);
      case "play": return void playWav(m.wav).catch((e) => add(`play failed: ${e.message}`));
      case "speak": return void Speech.speak(m.text);
      case "record": return void recordClip(m.id, m.seconds);
    }
  }

  async function start() {
    if (Platform.OS === "android") {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    }
    const w = new Worklet();
    w.start("/guardian.bundle", guardianBundle, []);
    worklet.current = w; ipc.current = w.IPC;
    let buf = "";
    w.IPC.on("data", (d: Uint8Array) => {
      buf += b4a.toString(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { onMessage(JSON.parse(line)); } catch {}
      }
    });
    send({ t: "init", role, secret, tzOffsetMinutes: new Date().getTimezoneOffset(), thresholdMinutes: 60 });
    setRunning(true);
  }
  function stop() {
    send({ t: "stop" });
    worklet.current?.terminate?.();
    worklet.current = ipc.current = null;
    setRunning(false); setPeers(0); setAwaiting(false);
  }
  useEffect(() => () => worklet.current?.terminate?.(), []);

  // ---------- optional: real motion data, one reading a minute
  useEffect(() => {
    if (!running || !useSensor || role !== "wearer") return;
    let sum = 0, n = 0;
    Accelerometer.setUpdateInterval(1000);
    const sub = Accelerometer.addListener(({ x, y, z }) => { sum += Math.abs(Math.sqrt(x * x + y * y + z * z) - 1); n++; });
    const t = setInterval(() => { if (n) send({ t: "reading", activity: sum / n }); sum = n = 0; }, 60000);
    return () => { sub.remove(); clearInterval(t); };
  }, [running, useSensor, role]);

  const Btn = ({ label, onPress, danger }: any) => (
    <Pressable onPress={onPress} style={[s.btn, danger && { backgroundColor: "#b3261e" }]}><Text style={s.btnText}>{label}</Text></Pressable>
  );

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.h1}>Guardian</Text>

      {alertBanner && (
        <Pressable style={s.banner} onPress={() => setAlertBanner(null)}>
          <Text style={s.bannerText}>⚠ {alertBanner}{"\n"}Tap to dismiss</Text>
        </Pressable>
      )}

      {!running && (
        <>
          <View style={s.row}>
            <Btn label={role === "wearer" ? "● I'm the wearer" : "○ I'm the wearer"} onPress={() => setRole("wearer")} />
            <Btn label={role === "contact" ? "● I'm the contact" : "○ I'm the contact"} onPress={() => setRole("contact")} />
          </View>
          <Text style={s.label}>Shared secret (same on both phones, keep private)</Text>
          <TextInput style={s.input} value={secret} onChangeText={setSecret} autoCapitalize="none" autoCorrect={false} />
          <Btn label="Start" onPress={start} />
        </>
      )}

      {running && (
        <>
          <Text style={s.status}>Role: {role}   ·   Peers connected: {peers}{role === "wearer" ? `   ·   Waiting for reply: ${awaiting ? "YES" : "no"}` : ""}</Text>
          {role === "wearer" && (
            <>
              <Btn label="I'm okay (button)" onPress={() => send({ t: "ack" })} />
              <Btn label="I moved" onPress={() => send({ t: "reading", activity: 0.9 })} />
              <Btn label="Simulate 61 min of stillness" onPress={() => send({ t: "simulate", minutes: 61 })} danger />
              <View style={s.row}><Text style={s.label}>Use phone motion sensor</Text><Switch value={useSensor} onValueChange={setUseSensor} /></View>
              <View style={s.row}><Text style={s.label}>Test: reply with im-okay.wav</Text><Switch value={fakeMic} onValueChange={setFakeMic} /></View>
            </>
          )}
          <Btn label="Stop" onPress={stop} />
        </>
      )}

      <Text style={s.label}>Log</Text>
      {log.map((l, i) => <Text key={i} style={s.log}>{l}</Text>)}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 60, gap: 12 },
  h1: { fontSize: 28, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 14, color: "#555" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  btn: { backgroundColor: "#1f5fbf", padding: 14, borderRadius: 10, alignItems: "center", flexShrink: 1 },
  btnText: { color: "#fff", fontWeight: "600" },
  status: { fontSize: 15 },
  banner: { backgroundColor: "#b3261e", padding: 16, borderRadius: 10 },
  bannerText: { color: "#fff", fontWeight: "700" },
  log: { fontFamily: Platform.OS === "android" ? "monospace" : "Menlo", fontSize: 11 },
});
