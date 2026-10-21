#!/usr/bin/env bash
# Runs inside the Android emulator job of website-source-test.yml.
# Serves test-inputs/sample-site on the host and checks a website-mode app loads it.
set -u
PKG=com.instapped.websitetest
APK=build/website/app/build/outputs/apk/debug/app-debug.apk
fail() { echo "::error title=Website runtime::$1"; exit 1; }
python3 -m http.server 8080 --bind 0.0.0.0 --directory test-inputs/sample-site >/tmp/website-server.log 2>&1 </dev/null &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
timeout 180 adb wait-for-device || fail "device did not come online"
for attempt in $(seq 1 24); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
adb install -r "$APK" || { sleep 20; adb install -r "$APK"; } || fail "adb install failed"
adb logcat -c || true
adb shell am start -n "$PKG/.MainActivity" || fail "could not start MainActivity"
LOG=""
for attempt in $(seq 1 30); do
  sleep 3
  LOG="$(adb logcat -d -v brief -s CastelAppFactory:I CastelAppFactory:E AndroidRuntime:E || true)"
  if printf '%s\n' "$LOG" | grep -qE 'PAGE_LOADED:http://10.0.2.2|PAGE_ERROR:|FATAL EXCEPTION'; then break; fi
done
printf '%s\n' "$LOG" | grep -E 'PAGE_|FATAL' | tail -n 10 | while IFS= read -r l; do echo "::notice title=Website logcat::$l"; done
printf '%s\n' "$LOG" | grep -q 'FATAL EXCEPTION' && fail "app crashed on launch"
printf '%s\n' "$LOG" | grep -q 'PAGE_ERROR:' && fail "WebView reported $(printf '%s\n' "$LOG" | grep -o 'PAGE_ERROR:.*' | head -n 1)"
printf '%s\n' "$LOG" | grep -q 'PAGE_LOADED:http://10.0.2.2' || fail "website did not load within 90 seconds"
grep -q '"GET / ' /tmp/website-server.log || fail "test server never received the app's request"
echo "Website-mode app loaded the site from the test server."
