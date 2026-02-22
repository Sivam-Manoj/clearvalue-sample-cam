# ClearValue Sample Cam

> A developer-focused Expo + VisionCamera sample app for **lot-based photo/video capture** with a simplified “camera check” flow.

---

## What this app currently does

- Opens into a simple home screen and launches camera check modal.
- Uses a simplified `AssetFormSheet` (camera-first, no appraisal/user details UI).
- Captures photos into lots with 3 capture modes:
  - `single_lot` (Bundle)
  - `per_item`
  - `per_photo`
- Supports:
  - lot navigation
  - extra images per lot
  - video capture
  - save to gallery
  - manual/tap focus behavior
  - zoom presets + pinch zoom
  - max-resolution-focused device/format selection

---

## Project entry + routing

- Root layout (router + gesture root): `app/_layout.tsx`
- Home screen: `app/index.tsx`
- Camera check modal: `components/forms/AssetFormSheet.tsx`
- Camera core: `components/camera/CameraScreen.tsx`

Important: `GestureDetector` in `CameraScreen` requires `GestureHandlerRootView` in root layout (already configured).

---

## Camera module structure

```text
components/camera/
  CameraScreen.tsx        # main capture engine + UI + permissions + format/device logic
  types.ts                # CaptureMode, PhotoFile, MixedLot
  TopControls.tsx         # flash/focus + done controls
  CaptureButtons.tsx      # mode-specific capture actions
  LotNavigation.tsx       # lot switching + stats
  FocusBox.tsx            # focus indicator overlay
  PhotoThumbnails.tsx     # preview strip
  RecordButton.tsx        # video recording button
  RecordingIndicator.tsx  # timer/recording state
  ZoomSlider.tsx          # zoom slider UI
  index.ts                # camera exports
```

Lot/image manager (outside camera module): `components/forms/LotManager.tsx`

---

## Data model (shared types)

Defined in `components/camera/types.ts`:

- `CaptureMode`: `single_lot | per_item | per_photo`
- `PhotoFile`: uri/name/type + optional metadata (width/height/megapixels/focusBox/adjustments)
- `MixedLot`: lot container with:
  - `files` (main images)
  - `extraFiles` (extra images)
  - `videoFile` (optional)
  - `mode`, `coverIndex`, `id`

---

## Capture flow (how it works)

1. `AssetFormSheet` opens `CameraScreen` with:
   - `lots`, `setLots`
   - `activeLotIdx`, `setActiveLotIdx`
   - `enhanceImages`, `onEnhanceChange`
2. `CameraScreen` requests camera/microphone/media permissions.
3. Camera device and format are selected with a high-resolution strategy.
4. Capture buttons create/update photos in the active lot:
   - main captures go to `lot.files`
   - extra captures go to `lot.extraFiles`
5. Photos are saved to gallery when media permission is granted.
6. Returning from camera shows updated lot/image state in `LotManager`.
7. Done in `AssetFormSheet` shows camera-check summary alert.

---

## Setup and run

### Prerequisites

- Node + npm
- Android Studio / Xcode (for native dev build)
- Expo CLI tools via `npx`

### Install

```bash
npm install
```

### Run (recommended for VisionCamera)

```bash
npm run dev
```

Useful scripts:

- `npm run android` -> `expo run:android`
- `npm run ios` -> `expo run:ios`
- `npm run run` -> clean prebuild + run android
- `npm run android-build` -> EAS production Android build

---

## Permissions + native dependencies

Configured via Expo + plugins and used in camera runtime:

- `react-native-vision-camera`
- `react-native-gesture-handler`
- `react-native-reanimated`
- `expo-media-library`
- `expo-image-picker`
- `expo-screen-orientation`
- `@react-native-community/slider`
- `@react-native-async-storage/async-storage`

`app.json` includes camera permission config and VisionCamera plugin.

---

## Current known issues (for next developer)

### 1) Performance issues (capture + UI responsiveness)

Observed causes:

- Heavy debug logging in `CameraScreen` on many code paths.
- Large component with many state updates and re-renders.
- Lot/image arrays are updated frequently with deep map/filter operations.

Impact:

- Possible jank during rapid capture and lot switching.

### 2) Low MP on some Android devices

Current state:

- App includes multiple safeguards (wide camera preference, format scoring, low-MP fallback switch).
- Despite this, some logical/multi-camera combinations can still yield lower-than-expected photo MP.

Known contributors:

- Android camera device/format differences across OEMs.
- ImageCapture behavior tied to selected format constraints.

### 3) Autofocus consistency

Current state:

- `focusOn` toggle exists and tap focus is implemented.
- iOS uses gesture tap focus path.
- Android uses touch-end fallback path with coordinate mapping.

Issue:

- Focus behavior can still vary by device and camera state.

### 4) Enhancement API path is intentionally disabled

- The backend optimization pipeline call is currently no-op in sample build.
- Toggle remains in UI, but network-based post-processing is disabled to avoid API/config dependency failures.

---

## Improvement roadmap

### P0 (high impact, low risk)

1. Gate noisy logs behind `__DEV__` and remove capture-loop logs in production.
2. Move camera debug instrumentation to a dedicated debug flag.
3. Add small capture benchmark metrics:
   - time-to-capture
   - capture-to-thumbnail render
   - dropped frame approximation

### P1 (image quality / low MP)

1. Persist per-device successful format and reuse it.
2. Build a device capability cache keyed by camera ID and format.
3. Add explicit "quality profile" selector (Speed / Balanced / Max Quality) visible to testers.
4. Validate if forcing max preset always is desired; currently resolution preset is aggressively pinned toward max mode.

### P1 (autofocus)

1. Unify focus pipeline so iOS and Android share the same coordinate normalization utility.
2. Add hysteresis/throttling for repeated focus calls while device is moving.
3. Add optional continuous autofocus + lock indicator states in UI.

### P2 (architecture)

1. Split `CameraScreen.tsx` into feature hooks:
   - `useCameraPermissions`
   - `useCameraDeviceSelection`
   - `useCapturePipeline`
   - `useFocusController`
2. Introduce reducer for lot mutations to reduce scattered array patching.
3. Add unit tests for format selection and lot mutation logic.

---

## Developer checklist before shipping

- [ ] Test on at least 3 Android OEM devices (Samsung, Pixel, OnePlus/Xiaomi).
- [ ] Verify captured MP against expected hardware ranges.
- [ ] Verify autofocus tap reliability in portrait + landscape.
- [ ] Stress test burst captures (50+ photos) for memory/perf.
- [ ] Confirm media library permission and save behavior.
- [ ] Confirm lot integrity after add/remove/edit operations.

---

## Notes

- This repository is intentionally a **sample camera app** and not the full production appraisal flow.
- Camera-related components are preserved; form UX is intentionally simplified for camera validation.
