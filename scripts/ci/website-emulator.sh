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
# Wait until the emulator's network reaches the host before opening the app.
for attempt in $(seq 1 20); do
  adb shell 'toybox nc -z -w 3 10.0.2.2 8080' >/dev/null 2>&1 && break
  sleep 3
done
adb logcat -c || true
LOG=""
for launch in 1 2; do
  adb shell am force-stop "$PKG" || true
  adb shell am start -n "$PKG/.MainActivity" || fail "could not start MainActivity"
  # If the first load fails while the network is still coming up, the app
  # retries by itself once a connection is available; give it time to.
  for attempt in $(seq 1 30); do
    sleep 3
    LOG="$(adb logcat -d -v brief -s CastelAppFactory:I CastelAppFactory:E AndroidRuntime:E || true)"
    if printf '%s\n' "$LOG" | grep -qE 'PAGE_LOADED:http://10.0.2.2|FATAL EXCEPTION'; then break 2; fi
  done
  echo "::warning title=Website runtime::launch $launch did not load the site; retrying once"
done
printf '%s\n' "$LOG" | grep -E 'PAGE_|FATAL' | tail -n 10 | while IFS= read -r l; do echo "::notice title=Website logcat::$l"; done
printf '%s\n' "$LOG" | grep -q 'FATAL EXCEPTION' && fail "app crashed on launch"
if ! printf '%s\n' "$LOG" | grep -q 'PAGE_LOADED:http://10.0.2.2'; then
  echo "::error title=App log::$(printf '%s\n' "$LOG" | grep -E 'CastelAppFactory|AndroidRuntime' | sed 's/^[A-Z]\/CastelAppFactory( *[0-9]*): //' | tail -n 25 | tr '\n' '|' | cut -c1-3000)"
  echo "::error title=Server log::$(tail -n 15 /tmp/website-server.log | tr '\n' '|' | cut -c1-1500)"
  echo "::error title=Host reachability::$(adb shell 'toybox nc -z -w 3 10.0.2.2 8080 && echo reachable || echo unreachable' 2>&1 | tr -d '\r')"
  fail "website did not load within 90 seconds"
fi
grep -q '"GET / ' /tmp/website-server.log || fail "test server never received the app's request"
echo "Website-mode app loaded the site from the test server."
