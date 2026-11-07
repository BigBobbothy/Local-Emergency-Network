# Guardian on Android with Pear: setup

Pear on a phone = a React Native/Expo app (the GUI) that hosts a **Bare worklet** (your logic + P2P)
via `react-native-bare-kit`. Android Studio is used for the Android SDK, NDK, emulator and build tools;
the screen itself is React Native (TypeScript), not Kotlin.

NOT TESTED ON A DEVICE. Pear mobile is labelled MVP/experimental, and QVAC-on-Android is the
part I could not confirm. Do step 3 first so you know the toolchain works before adding anything.

## 1. Computer
- Node.js >= 20.19.4
- Android Studio -> SDK Manager: latest Android SDK Platform, Platform-Tools, **NDK (Side by side)**,
  **CMake**, Command-line Tools. (Phone needs Android 10 / API 29 or newer, 64-bit ARM.)
- Environment variable `ANDROID_HOME` = your SDK folder (Windows default:
  `C:\Users\<you>\AppData\Local\Android\Sdk`); add `platform-tools` to PATH.
- Restart the terminal, then check: `adb version`

## 2. Phone (do this on BOTH phones: wearer and contact)
1. Settings -> About phone -> tap **Build number** 7 times.
2. Settings -> System -> Developer options -> turn on **USB debugging**.
3. Plug in via USB, accept "Allow USB debugging?" on the phone.
4. `adb devices` must list it as `device` (not `unauthorized`).
5. After install: Settings -> Apps -> Guardian -> Permissions -> allow **Microphone**; Battery ->
   **Unrestricted**. Otherwise Android pauses the app and monitoring silently stops.

## 3. Get the official Pear template running first
    git clone https://github.com/holepunchto/hello-pear-react-native
    cd hello-pear-react-native
    npm install
    npm run android
This is a development build (not Expo Go; Expo Go cannot run Bare). First build takes a while.

## 4. Add Guardian
    npm install hyperswarm hypercore-crypto b4a bare-buffer abort-controller @qvac/sdk
    npx expo install expo-speech expo-audio expo-sensors expo-asset expo-file-system
    npm install react-native-audio-record

Copy from this folder:
- `worker/`  -> project root (`worker/guardian.js`, `inactivity.js`, `qvac-helpers.js`)
- `src/GuardianScreen.tsx` -> `src/`
- `assets/im-okay.wav` -> `assets/`

In `src/App.tsx` render `<GuardianScreen />` (keep the template's Pear update code if you want OTA).

Bundle the worker. Open the template's `package.json`, find the `bundle:bare` script, copy it as
`bundle:guardian`, and change the entry to `worker/guardian.js` and the output to
`src/guardian.bundle.js`. It will look roughly like:
    bare-pack --linked --host android-arm64 --host android-arm --host android-x64 --out src/guardian.bundle.js worker/guardian.js
If the template links native addons with a separate step (look for `bare-link` in package.json), re-run it.
Android permissions: add `android.permission.RECORD_AUDIO` to `app.json` -> `android.permissions`.

    npm run bundle:guardian
    npm run android

## 5. Try it
1. Phone A: pick **contact**, enter a secret, Start. Phone B: **wearer**, same secret, Start.
2. Peers should show 1 on both (needs internet at least briefly for discovery).
3. Wearer: **Simulate 61 min of stillness** -> check-in is spoken.
   - Say "I'm okay" (or turn on the im-okay.wav test switch) -> acknowledged, no alert.
   - Do nothing for 15 minutes -> alert_raised -> red banner on the contact's phone.

## Known limits (read these)
- **Backgrounding:** if Android freezes the app, nothing monitors and the contact receives nothing.
  The contact's app must also be running to receive an alert; there is no push notification.
  Do not rely on this as someone's only safety net. It also never contacts emergency services (by design in your code).
- **Voice replies on a phone:** QVAC's default ASR model is ~740 MB. Pass `asrModelSrc` for a smaller one.
  If QVAC fails to load, the app falls back to the phone's own speech and the on-screen button.
- Anyone who learns the shared secret can join the swarm. Use a long random string.
- Baseline learning is in-memory only here (resets on restart).
