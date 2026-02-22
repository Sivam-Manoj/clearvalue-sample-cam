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

