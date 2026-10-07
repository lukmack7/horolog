# Planer Horolog — Android

Native Android shell for the self-hosted Horolog web application.

## Current MVP

- opens the self-hosted Horolog instance at `http://horolog:3000`
- relies on Tailscale/MagicDNS for the same address on Wi-Fi and LTE
- native offline/server-unavailable screen with **Open Tailscale** and **Retry**
- Android Share target: **Share → Planer Horolog** pre-fills **Do zrobienia**
- notification channels prepared for:
  - task/meeting reminders
  - deadline alerts
  - end-of-day review + tomorrow planning
- launcher shortcuts for **Planner** and **Do zrobienia**
- Android 15 target, min Android 8

## Test device

Initial target:
- realme GT 2 Pro
- Android 15
- realme UI 6.0

## Build without Android Studio

GitHub Actions workflow:

`.github/workflows/android-debug.yml`

Open the repository **Actions** tab, select **Android debug APK**, run the
workflow if needed, then download the `Planer-Horolog-debug` artifact.

The APK inside is `app-debug.apk`.

## First test

1. Keep Tailscale connected.
2. Confirm `http://horolog:3000` works in the phone browser.
3. Install the debug APK.
4. Launch **Planer Horolog**.
5. The app should open the Planner immediately.
6. Long-press the app icon and test **Planner** / **Do zrobienia** shortcuts.
7. In any Android app, share text and choose **Planer Horolog**. The text
   should appear pre-filled in **Do zrobienia**.
8. Temporarily disconnect Tailscale and reload. The native connection screen
   should appear.

## Next mobile milestones

- local plan cache
- exact/local task reminders
- max-deadline alerts
- configurable end-of-day review reminder
- actions from notifications (Done, open, remind later)
- **Now / Next** home-screen widget
- queued offline additions to **Do zrobienia**
- optional Tailscale Serve HTTPS endpoint
