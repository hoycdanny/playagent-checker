# Design: Device Farm real-device runner

## Why Fargate, not Lambda

Driving a real device means: pull a possibly multi-hundred-MB APK from S3, (sometimes) merge split APKs, upload to AWS Device Farm, open a remote-access session, then run a multi-minute Appium loop. The Engine Lambda (512 MB, short timeout) cannot do this. So the Engine only calls `ecs:RunTask` and returns; all heavy work happens in the Fargate runner container (`agent/explorationRunner.mjs`).

## Flow inside the runner

1. **Download** the artifact from S3 to local temp.
2. **XAPK / split-APK merge** (`apkMerge.mjs`): AWS Device Farm accepts only a single APK. If the artifact is a ZIP-of-APKs (XAPK/APKM), merge to a universal APK with APKEditor 1.4.9. The merged output must pass local ZIP + `aapt dump badging`, then it is explicitly `zipalign`ed, signed with an isolated test-only debug key, checked by `apksigner verify`, and validated by `aapt` again before upload. A guard skips merge when the file is already a valid standalone APK. If local `aapt` cannot parse the merged manifest/resources, the runner reports that diagnostic immediately instead of uploading a known-bad file and returning Device Farm's generic `ANDROID_APP_AAPT_DEBUG_BADGING_FAILED`. Re-signing means signature-bound OAuth / Play Integrity may not work; those apps need a developer-provided universal APK signed with the original app key.
3. **ABI-aware device selection**: if the APK is 32-bit-only (`armeabi-v7a`, no 64-bit lib), prefer a device that supports 32-bit (older OS), avoiding `INSTALL_FAILED_NO_MATCHING_ABIS` on 64-bit-only devices.
4. **Upload** to Device Farm (us-west-2), create a remote-access session, obtain the Appium endpoint.
5. **Run the loop** (screenshot → VLM → decide → act) via Appium, refreshing the pre-signed driver endpoint (~15 min expiry) as needed.
6. **Write** screenshots/steps/traces/report/status and the incremental memory map to S3 throughout.

## Coordinates

Screenshots are smart-resized before being sent to the VLM; the model returns coordinates in that frame, which are scaled back to device pixels for Appium taps. This is shared with the Web runner and with the UI-TARS grounding path.

## Device selection

By default the runner picks the first available remote-access phone whose OS fits the (optional) version window. Users can instead pick an exact device at submit time:

- The submit form (Tasks page and the app workspace) shows a device dropdown, gated to the `devicefarm` backend, populated from `GET /devices/cloud` (AWS Device Farm `ListDevices`, cached ~5 min). Each option shows the model and Android version, plus a characteristics line (resolution, memory, CPU clock in GHz — Device Farm reports `cpu.clock` in **MHz**, so it is divided by 1000 for display).
- The chosen device's `deviceArn` (plus `deviceModel`/`osVersion` for display) is validated and stored in `job.json`. Note that AWS public device ARNs have an **empty account segment** (e.g. `arn:aws:devicefarm:us-west-2::device:...`), so the validation regex allows an empty account.
- The Engine reads these via `readJobMeta` and forwards `deviceArn` (and, when no ARN is set, an OS window derived from `osVersion`) to the runner as `PA_DEVICE_ARN` / `PA_DEVICE_MODEL`. `deviceFarmSetup.resolveDeviceArn` short-circuits to the provided ARN, so the exact device is used rather than "first available".

## Recording which device ran

The physical device that actually ran a task is captured and shown back to the user:

- The runner reads the real model from the Device Farm session (fallback: Appium capabilities via `AppiumClient.deviceInfo()`, then the submitted `PA_DEVICE_MODEL`) and writes it to `report.json` as `deviceModel`.
- The API's `buildTaskMeta` surfaces it as `meta.deviceModel` (preferring the runner-reported value, falling back to the submitted one while the task is still running).
- The task detail page renders it as an "執行裝置 / Ran on device" row.

## Failure handling

- Consecutive screenshot/act failures beyond a limit end the run with `error`.
- Loop/stuck detection ends early with a clear message instead of spinning.
- **Frozen-screen patience + abort**: when the screen (perceptual hash) does not change for several consecutive steps, the runner does not blindly tap. It first waits patiently — especially when the screen looks like an install/loading screen (a large APK's first install can take minutes) — and only after a longer unchanged window rotates through escape actions. If the screen is *still* completely unchanged past a hard cap, the run ends as `error` with a clear message rather than spinning forever (which, on a metered real device, would keep billing). The Web runner has an equivalent frozen-screen abort (also treating login/`reCAPTCHA` walls as a stuck loading state).
- The top-level handler always stops the self-owned Device Farm session on exit to release the device and stop billing.
