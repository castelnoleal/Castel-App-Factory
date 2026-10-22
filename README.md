# EDOPro Synapse – Android build branch

Isolated branch, unrelated to instApped's code. Holds a single GitHub Actions
workflow that builds the **EDOPro Synapse** Android app (EDOPro + the Synapse
learned AI, which runs on your PC). The build downloads edopro-android itself.

* Rebuild with a different PC address or token: edit `SERVER_URL` / `SERVER_TOKEN`
  in `.github/workflows/synapse-android.yml` and commit to this branch.
* Download: Actions → the latest "EDOPro Synapse APK" run → artifact **EDOPro-Synapse**.
* Remove: delete this branch.
