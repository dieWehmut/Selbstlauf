# Android Studio and launcher icon acceptance

This continues task `01a1c1f4-02fd-7fb2-a61e-3a1944f63025` from main revision
`9713c1f`. Existing remote-control acceptance is recorded in
[the earlier report](2026-11-10-mobile-remote.md). Production icon revision
`863e350` has been pushed and fast-forward merged to main.

## Artwork

Android launcher assets now derive from the desktop's checked-in
`assets/selbstlauf-icon-source.png`. Legacy square icons use the full artwork.
Adaptive layers place it in the central 66dp area of a 108dp layer and extend
edge pixels through the remaining area; circular and rounded masks retain the
character without the former brown frame. The existing splash artwork is
unchanged and already uses this source.

`scripts/mobile/generate-icon-assets.py` reproduces all 15 PNGs and the background
color using the pinned Pillow tooling dependency. Validation confirmed density
dimensions, source-derived pixels, round fallback alpha, opaque adaptive layers,
and identical SHA-256 outputs after regeneration. The desktop ICO's 256px frame
and web brand image have identical decoded pixels.

The installed APK was visually inspected on the actual API 36 emulator, both on
the home screen and in the application drawer. The latter shows the new round
artwork and the label **Selbstlauf**. Evidence is under
`tmp/android-studio-20261110/`: `launcher-home.png`, `launcher-drawer.png`, and
their layout dumps.

## Build and runtime

Current validation, using Java 21 and Android SDK 36:

| Check | Result |
| --- | --- |
| Mobile unit tests | 25 passed |
| Mobile typecheck and production build | Passed |
| APK and instrumentation APK build | Passed |
| Android lint | 0 errors, 16 warnings |
| Native remote journey | 4 passed, including the parameterized remote test |
| Clean cold launch | Control panel and four-tab navigation displayed |

The native journey used Linux `emulator-5554` (`orchester-qa`), an isolated
gateway with a one-time pairing code, disposable discovered-session fixtures,
and a real host Shell PTY. `native-linux/native-terminal.png` contains the
independent `SELBSTLAUF_NATIVE_LINK` output line and the following shell prompt.
`native-linux/instrumentation.log` reports `OK (4 tests)`; `result.json` records
the actual backend and link. This is local emulator acceptance using `adb
reverse`; physical-phone Wi-Fi/VPN acceptance is not claimed.

After extracting evidence, only this newly installed test application's data
was cleared to remove its expired temporary pairing. Other applications on the
emulator were preserved. `clean-app.png` and `clean-app-layout.json` show the
unpaired initial control panel. The journey cleaned its gateway, PTY, temporary
service state, and reverse mapping.

Commands:

```sh
npm run build --workspace @ai-cli-bypass/cli
npm run sync --workspace @ai-cli-bypass/mobile
cd apps/mobile/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug --no-daemon --max-workers=2
cd ../../..
ANDROID_SERIAL=emulator-5554 SELBSTLAUF_MOBILE_EVIDENCE=tmp/android-studio-20261110/native-linux node scripts/verify/mobile-android-live.mjs
```

The debug APK used by the native journey is 18,899,929 bytes, SHA-256
`e4d32bf866111bf60b78f459f6761b9de616ceacdb7ff3e0fdfbd1ded0ba4091`.
The instrumentation APK SHA-256 is
`48b8a6daabe9040066b153d4e1ec61c7d14cfdaa7a0f92370664694cf12090ec`.
`artifacts-linux.json` binds these artifacts to the Android sources/resources,
desktop ICO, and source artwork. Full Gradle output is `gradle-linux.log`.

## Android Studio

Windows Android Studio Rabbit 2 Patch 1 was detected. WSL's Windows process
launch interface repeatedly returned `UtilAcceptVsock: accept4 failed 110`, so
Windows IDE deployment was not used as acceptance evidence.

The existing local Linux installation of the same Studio version was launched
in an independent instance, opening this repository's `apps/mobile/android`.
Config, system, and logs are isolated under
`tmp/mobile-android-studio-20261110/`; the existing Sandkasten Studio instance
was preserved. The project uses Java 21, SDK 36, and the existing Gradle/AGP
versions. Local IDE/JDK settings are not committed.

Studio's own Gradle tooling reports `onSuccess(RESOLVE_PROJECT:0)` and
`Gradle sync finished in 26 s 589 ms`. The app and both Capacitor modules were
imported, and the `app` Run configuration was created.

The IDE then ran `:app:assembleDebug` with
`android.injected.invoked.from.ide=true`, reported **BUILD SUCCESSFUL**, installed
the app successfully, and launched `de.diewehmut.selbstlauf.MainActivity` on
`emulator-5554`. Its build output, installation notification, and launched app
are captured in `studio-build-success.png`, `studio-run-progress.png`, and
`studio-launched-app.png`. The activity remained foreground with app PID 7098.

Studio initially attempted incremental deployment of the manually installed
APK and fell back to regular installation. The installed IDE variant and the
build APK were compared by ZIP entry: 432 of 433 entries are identical, including
all icons, web assets, and DEX. The manifest is the only differing entry, adding
the IDE's `android:testOnly=true` attribute and XML line metadata. The comparison
is in `studio-installed-entry-audit.json` and `studio-manifest-diff.txt`.

Studio's final build APK is 18,642,963 bytes, SHA-256
`892009f9f2f114eebb76dbadffcad1a067cc377cb6d283bbd3625363e9307c26`.
The deliverable copy is
`tmp/android-studio-20261110/Selbstlauf-0.1.0-debug.apk`.

That final Studio-built APK was installed again and passed all four native tests,
including the real Shell journey. Evidence is
`tmp/android-studio-20261110/native-studio-apk/`; its terminal screenshot again
shows the independent marker output. The temporary pairing was then cleared and
the app reopened, with the Studio instance left available for local use.

`tmp/android-studio-20261110/final-acceptance.json` verifies all 54 Studio source
hashes, records the four-test result, confirms that the installed `base.apk`
exactly matches the deliverable SHA-256, and records the foreground activity
and empty reverse mappings. `final-clean-app.png`, `final-clean-layout.json`,
and `final-clean-launch.log` capture the final unpaired state. The report and
Studio instructions are a separate documentation commit; no production code
changed after revision `863e350`.
