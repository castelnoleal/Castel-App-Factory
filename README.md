# EDOPro Synapse – Android build branch

Two apps are built here:

* **EDOPro Synapse** (`synapse-android.yml`) – the AI runs on your PC, the phone connects over Wi-Fi.
* **EDOPro Synapse Offline** (`synapse-android-offline.yml`) – the AI runs on the phone itself.

Isolated branch, unrelated to instApped's code. Holds a single GitHub Actions
workflow that builds the **EDOPro Synapse** Android app (EDOPro + the Synapse
learned AI, which runs on your PC). The build downloads edopro-android itself.

* Rebuild with a different PC address or token: edit `SERVER_URL` / `SERVER_TOKEN`
  in `.github/workflows/synapse-android.yml` and commit to this branch.
* Download: Actions → the latest "EDOPro Synapse APK" / "EDOPro Synapse Offline APK" run → artifact **EDOPro-Synapse** / **EDOPro-Synapse-Offline**.
* Remove: delete this branch.
