#!/usr/bin/env bash
# Runs inside the Android emulator job of web-compat-test.yml.
set -eu
APK=generated-app/app/build/outputs/apk/debug/app-debug.apk
PKG=com.castel.webcompat
adb wait-for-device
for attempt in 1 2 3 4 5 6 7 8; do
  booted="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [ "$booted" = "1" ]; then break; fi
  sleep 5
done
adb shell cmd package list packages >/dev/null 2>&1 || { adb kill-server; adb start-server; adb wait-for-device; sleep 10; }
adb install -r "$APK"
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
for attempt in $(seq 1 40); do
  sleep 3
  adb logcat -d > /tmp/webcompat.log || true
  if grep -E 'WEBCOMPAT:(ALL_PASS|SOME_FAILED)' /tmp/webcompat.log >/dev/null; then break; fi
done
grep -F 'WEBCOMPAT:' /tmp/webcompat.log | sed 's/.*WEBCOMPAT:/WEBCOMPAT:/' | sed 's/".*//' | sort -u > /tmp/webcompat-results.txt || true
cat /tmp/webcompat-results.txt
# Surface each result as a GitHub annotation so failures are visible without logs.
while IFS= read -r line; do
  case "$line" in *:FAIL*|*SOME_FAILED*) echo "::error title=Web compatibility::$line" ;; *) echo "::notice title=Web compatibility::$line" ;; esac
done < /tmp/webcompat-results.txt
if [ ! -s /tmp/webcompat-results.txt ]; then
  # One annotation (GitHub keeps only 10 per step) with the lines that matter.
  summary="$(grep -E 'CastelAppFactory|CONSOLE|AndroidRuntime|FATAL|LAUNCH_FAILED' /tmp/webcompat.log | sed 's/^[0-9-]* [0-9:.]* *[0-9]* *[0-9]* //' | tail -n 25 | tr '\n' '|' | cut -c1-3500)"
  echo "::error title=Web compatibility::No WEBCOMPAT output. Log: ${summary:-no app log lines}"
  top="$(adb shell dumpsys activity top | grep -E 'ACTIVITY|mResumed' | head -n 3 | tr '\n' ' ')"
  APP_PID="$(adb shell pidof "$PKG" | tr -d '\r' | awk '{print $1}')"
  adb logcat -d -v brief > /tmp/webcompat-brief.log || true
  { [ -n "$APP_PID" ] && grep -E "\( *$APP_PID\)" /tmp/webcompat-brief.log; grep -E "ANR|am_anr|Input dispatching|CastelAppFactory|chromium" /tmp/webcompat-brief.log; } | grep -vE "variations_seed|DnsConfig" | tail -n 120 > /tmp/webcompat-app.log || true
  split -l 30 /tmp/webcompat-app.log /tmp/webcompat-part- || true
  for part in /tmp/webcompat-part-*; do [ -f "$part" ] && echo "::warning title=App log $(basename "$part")::$(tr '\n' '|' < "$part" | cut -c1-6000)"; done
  echo "::error title=Activity::${top}"
fi
if grep -E 'FATAL EXCEPTION' /tmp/webcompat.log >/dev/null; then echo "::error title=Web compatibility::App crashed"; grep -A20 "FATAL EXCEPTION" /tmp/webcompat.log | head -n 25 | while IFS= read -r l; do echo "::error title=crash::$l"; done; exit 1; fi
if ! grep -F 'WEBCOMPAT:ALL_PASS' /tmp/webcompat.log >/dev/null; then
  echo "Web compatibility checks failed."
  tail -n 300 /tmp/webcompat.log
  exit 1
fi
# Rotation must keep the page (no reload back to the start).
adb logcat -c
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 5
adb logcat -d > /tmp/webcompat-rotate.log || true
if grep -F 'WEBCOMPAT:MODULE_IMPORT' /tmp/webcompat-rotate.log >/dev/null; then echo "::error title=Web compatibility::Page reloaded on rotation"; exit 1; fi
if grep -E 'FATAL EXCEPTION' /tmp/webcompat-rotate.log >/dev/null; then echo "::error title=Web compatibility::App crashed on rotation"; exit 1; fi
echo "Web compatibility acceptance passed."
