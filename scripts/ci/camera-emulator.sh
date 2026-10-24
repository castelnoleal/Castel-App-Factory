#!/usr/bin/env bash
# Runs inside the Android emulator job of camera-test.yml.
set -u
fail() { echo "::error title=Camera::$1"; exit 1; }
retry() { for i in 1 2 3 4; do "$@" && return 0; echo "retry $i: $*"; adb reconnect >/dev/null 2>&1 || true; sleep 15; timeout 120 adb wait-for-device; done; return 1; }
APK=generated-app/app/build/outputs/apk/debug/app-debug.apk
PKG=com.castel.cameratest
timeout 180 adb wait-for-device || fail "device did not come online"
for attempt in $(seq 1 12); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 5; done
retry adb install -r "$APK" || fail "adb install failed"
# Grant the Android permission up front (a person would tap Allow on the dialog).
adb shell pm grant "$PKG" android.permission.CAMERA || fail "could not grant CAMERA"
adb shell dumpsys media.camera 2>/dev/null | grep -iE "Camera [0-9]|Number of camera" | head -n 5 | while IFS= read -r l; do echo "::notice title=Emulator camera::$l"; done
adb logcat -c || true
retry adb shell am start -n "$PKG/.MainActivity" || fail "could not start the app"
for attempt in $(seq 1 40); do
  sleep 3
  adb logcat -d > /tmp/camera.log || true
  grep -E 'CAMERA:(ALL_PASS|SOME_FAILED)' /tmp/camera.log >/dev/null && break
done
grep -F 'CAMERA:' /tmp/camera.log | sed 's/.*CAMERA:/CAMERA:/' | sed 's/", source.*//' | sort -u > /tmp/camera-results.txt || true
while IFS= read -r line; do
  case "$line" in *:FAIL*|*SOME_FAILED*) echo "::error title=Camera::$line" ;; *) echo "::notice title=Camera::$line" ;; esac
done < /tmp/camera-results.txt
if [ ! -s /tmp/camera-results.txt ]; then
  summary="$(grep -E 'CastelAppFactory|chromium|cr_|Camera|AndroidRuntime|FATAL' /tmp/camera.log | tail -n 30 | tr '\n' '|' | cut -c1-3500)"
  fail "No CAMERA output. Log: ${summary}"
fi
grep -E 'chromium|cr_media|VideoCapture|Camera2' /tmp/camera.log | grep -iE "error|fail|denied" | tail -n 8 | while IFS= read -r l; do echo "::warning title=Camera log::$l"; done
grep -F 'CAMERA:ALL_PASS' /tmp/camera.log >/dev/null || fail "the page could not use the camera (see the results above)"
echo "Camera acceptance passed."
