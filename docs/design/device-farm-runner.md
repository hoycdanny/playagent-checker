# Design: Device Farm real-device runner

## Why Fargate, not Lambda

Driving a real device means: pull a possibly multi-hundred-MB APK from S3, (sometimes) merge split APKs, upload to AWS Device Farm, open a remote-access session, then run a multi-minute Appium loop. The Engine Lambda (512 MB, short timeout) cannot do this. So the Engine only calls `ecs:RunTask` and returns; all heavy work happens in the Fargate runner container (`agent/explorationRunner.mjs`).

## Flow inside the runner

1. **Download** the artifact from S3 to local temp.
2. **XAPK / split-APK merge** (`apkMerge.mjs`): AWS Device Farm accepts only a single APK. If the artifact is a ZIP-of-APKs (XAPK/APKM), merge to a universal APK with APKEditor. A guard skips merge when the file is already a valid standalone APK (root `AndroidManifest.xml` + `classes*.dex`), and falls back to the original APK if a merge unexpectedly fails.
3. **ABI-aware device selection**: if the APK is 32-bit-only (`armeabi-v7a`, no 64-bit lib), prefer a device that supports 32-bit (older OS), avoiding `INSTALL_FAILED_NO_MATCHING_ABIS` on 64-bit-only devices.
4. **Upload** to Device Farm (us-west-2), create a remote-access session, obtain the Appium endpoint.
5. **Run the loop** (screenshot → VLM → decide → act) via Appium, refreshing the pre-signed driver endpoint (~15 min expiry) as needed.
6. **Write** screenshots/steps/traces/report/status and the incremental memory map to S3 throughout.

## Coordinates

Screenshots are smart-resized before being sent to the VLM; the model returns coordinates in that frame, which are scaled back to device pixels for Appium taps. This is shared with the Web runner and with the UI-TARS grounding path.

## Failure handling

- Consecutive screenshot/act failures beyond a limit end the run with `error`.
- Loop/stuck detection ends early with a clear message instead of spinning.
- The top-level handler always stops the self-owned Device Farm session on exit to release the device and stop billing.
