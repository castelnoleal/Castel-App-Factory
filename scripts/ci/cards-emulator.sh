#!/usr/bin/env bash
# Runs inside the Android emulator job of build-cards-test.yml.
# Launches the MEIOCG Cards website app and checks the page reaches the WebView.
set -u
PKG=org.meiocg.cards
APK=build/cards/app/build/outputs/apk/debug/app-debug.apk
fail() { echo "::error title=Cards runtime::$1"; exit 1; }
adb wait-for-device
for attempt in $(seq 1 24); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
adb install -r "$APK" || fail "adb install failed"
adb logcat -c || true
adb shell am force-stop "$PKG" || true
adb shell am start -n "$PKG/.MainActivity" || fail "could not start MainActivity"
LOG=""
for attempt in $(seq 1 20); do
  sleep 3
  LOG="$(adb logcat -d -v brief -s CastelAppFactory:I CastelAppFactory:E CastelAppFactory:W AndroidRuntime:E || true)"
  if printf '%s\n' "$LOG" | grep -qE 'PAGE_LOADED:|PAGE_ERROR:|FATAL EXCEPTION'; then break; fi
done
printf '%s\n' "$LOG" | tail -n 60
printf '%s\n' "$LOG" | grep -E 'PAGE_|FATAL|Exception' | tail -n 20 | while IFS= read -r l; do echo "::notice title=Cards logcat::$l"; done
if printf '%s\n' "$LOG" | grep -q 'FATAL EXCEPTION'; then fail "app crashed on launch"; fi
if printf '%s\n' "$LOG" | grep -q 'PAGE_ERROR:'; then
  CODE="$(printf '%s\n' "$LOG" | grep -o 'PAGE_ERROR:.*' | head -n 1 | awk -F: '{print $NF}' | tr -d '\r ')"
  case "$CODE" in
    -2|-6|-7|-8)
      # Host lookup / connect / timeout: the hosted emulator has no usable internet.
      # The app itself launched and showed its offline screen, which is what we test here.
      adb shell dumpsys activity activities | tr -d '\r' | grep -q "$PKG" || fail "MainActivity not running after network error"
      echo "::warning title=Cards runtime::The emulator could not reach cards.meiocg.org (WebView error $CODE). App launch verified; live site not checked."
      exit 0 ;;
    *) fail "WebView reported PAGE_ERROR $CODE" ;;
  esac
fi
printf '%s\n' "$LOG" | grep -q 'PAGE_LOADED:' || fail "no PAGE_LOADED within 60 seconds"
adb shell dumpsys activity activities | tr -d '\r' | grep -q "$PKG" || fail "MainActivity not in ActivityManager"
echo "MEIOCG Cards remote website reached WebView successfully."
