#!/usr/bin/env bash
# Runs inside the Android emulator job of offline-storage-test.yml.
set -eu
APK=generated-app/app/build/outputs/apk/debug/app-debug.apk
PKG=com.castel.offlinetest
# Background test server; stopped on exit so the emulator step can finish.
python3 -m http.server 8765 --bind 0.0.0.0 --directory offline-test/server >/tmp/offline-bundle-server.log 2>&1 </dev/null &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
# Avoid the emulator action's post-boot animation settings; they can
# intermittently break adb on hosted runners. Wait for Android and retry adb.
adb wait-for-device
for attempt in 1 2 3 4 5; do
  booted="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r' || true)"
  if [ "$booted" = "1" ]; then break; fi
  sleep 5
done
test "$(adb shell getprop sys.boot_completed | tr -d '\\r')" = "1"
adb shell cmd package list packages >/dev/null 2>&1 || { adb kill-server; adb start-server; adb wait-for-device; sleep 10; }
adb install -r "$APK"
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
sleep 10
adb logcat -d > /tmp/offline-download.log || true
if ! grep -F 'OFFLINE_TEST:BUNDLE_DOWNLOAD_OK' /tmp/offline-download.log >/dev/null; then
  echo "Initial persistent-data/bundle download did not complete."
  grep -E "OFFLINE_TEST:|FATAL|CastelAppFactory" /tmp/offline-download.log | tail -n 40 | while IFS= read -r l; do echo "::error title=offline download::$l"; done
  exit 1
fi
adb shell am force-stop "$PKG"
adb shell cmd connectivity airplane-mode enable || true
sleep 2
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
sleep 8
adb logcat -d > /tmp/offline-relaunch.log || true
if ! grep -F 'OFFLINE_TEST:OFFLINE_PERSISTENCE_PASS' /tmp/offline-relaunch.log >/dev/null; then
  echo "Persisted data was not readable after app restart/offline mode."
  grep -E "OFFLINE_TEST:|FATAL|CastelAppFactory" /tmp/offline-relaunch.log | tail -n 40 | while IFS= read -r l; do echo "::error title=offline relaunch::$l"; done
  exit 1
fi
echo "Offline persistent storage acceptance passed."
