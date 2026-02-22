import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as MediaLibrary from "expo-media-library";
import * as ScreenOrientation from "expo-screen-orientation";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  Extrapolate,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useSharedValue,
} from "react-native-reanimated";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { CameraProps } from "react-native-vision-camera";
import {
  Camera,
  CameraDevice,
  useCameraDevice,
  useCameraDevices,
  useCameraPermission,
  useMicrophonePermission,
  VideoFile as VisionVideoFile,
} from "react-native-vision-camera";

import AsyncStorage from "@react-native-async-storage/async-storage";

import CaptureButtons from "./CaptureButtons";
import FocusBox from "./FocusBox";
import LotNavigation from "./LotNavigation";
import PhotoThumbnails from "./PhotoThumbnails";
import RecordButton from "./RecordButton";
import RecordingIndicator from "./RecordingIndicator";
import { DoneButton, TopControls } from "./TopControls";
import { CaptureMode, createNewLot, MixedLot, PhotoFile } from "./types";

interface CameraScreenProps {
  visible: boolean;
  onClose: () => void;
  lots: MixedLot[];
  setLots: React.Dispatch<React.SetStateAction<MixedLot[]>>;
  activeLotIdx: number;
  onAutoSave?: () => void; // Callback to trigger auto-save after capture
  setActiveLotIdx: React.Dispatch<React.SetStateAction<number>>;
  enhanceImages?: boolean; // Whether to enhance images on server
  onEnhanceChange?: (enabled: boolean) => void; // Callback when enhance toggle changes
}

// Flash mode type for vision camera
type FlashMode = "off" | "on" | "auto";

type CameraPerformanceMode = "speed" | "balanced" | "quality";

const ReanimatedCamera = Reanimated.createAnimatedComponent(Camera);

const SCALE_FULL_ZOOM = 3;

const AUTO_ENHANCE_KEY = "@camera_auto_enhance";
const CAMERA_PERFORMANCE_MODE_KEY = "@camera_performance_mode";

type ResolutionPreset = "auto" | "max" | number;

const clamp = (value: number, min: number, max: number) => {
  "worklet";
  return Math.max(min, Math.min(max, value));
};

const calcMegapixels = (width?: number, height?: number) => {
  if (!width || !height) return undefined;
  return (width * height) / 1_000_000;
};

const getMaxFormatMegapixels = (formats: any[]) => {
  let max = 0;
  for (const f of formats ?? []) {
    const mp = calcMegapixels(f?.photoWidth, f?.photoHeight);
    if (mp && mp > max) max = mp;
  }
  return max > 0 ? max : undefined;
};

const formatMegapixelsLabel = (mp?: number) => {
  if (!mp || !Number.isFinite(mp)) return "—";
  if (mp >= 100) return `${mp.toFixed(0)}MP`;
  if (mp >= 10) return `${mp.toFixed(0)}MP`;
  return `${mp.toFixed(1)}MP`;
};

const getAspectPenalty = (width?: number, height?: number) => {
  if (!width || !height) return 1;
  const r = Math.max(width, height) / Math.min(width, height);
  const target = 4 / 3;
  return Math.abs(r - target);
};

const pickBestPhotoFormat = (
  formats: any[],
  preset: ResolutionPreset,
  minRecommendedMP = 10,
) => {
  if (!Array.isArray(formats) || formats.length === 0) return undefined;

  // For 'max' preset: On Android, CameraX uses videoWidth/videoHeight for ImageCapture
  // So we must prioritize formats with HIGH VIDEO RESOLUTION to get max photo quality
  if (preset === "max") {
    const isAndroid = Platform.OS === "android";
    const mapped = [...formats]
      .map((f) => {
        const pw = Number(f?.photoWidth ?? 0);
        const ph = Number(f?.photoHeight ?? 0);
        const vw = Number(f?.videoWidth ?? 0);
        const vh = Number(f?.videoHeight ?? 0);
        const photoPixels = pw * ph;
        const videoPixels = vw * vh;
        return { f, photoPixels, videoPixels, pw, ph, vw, vh };
      })
      .filter((x) => x.photoPixels > 0);

    if (isAndroid) {
      const maxVideoPixels = mapped.reduce(
        (best, x) => Math.max(best, x.videoPixels),
        0,
      );
      const nearMaxVideo =
        maxVideoPixels > 0
          ? mapped.filter(
              (x) => x.videoPixels > 0 && x.videoPixels >= maxVideoPixels * 0.9,
            )
          : mapped.filter((x) => x.videoPixels > 0);
      const candidates = nearMaxVideo.length > 0 ? nearMaxVideo : mapped;
      const sorted = candidates.sort((a, b) => {
        if (b.videoPixels !== a.videoPixels)
          return b.videoPixels - a.videoPixels;
        if (b.photoPixels !== a.photoPixels)
          return b.photoPixels - a.photoPixels;
        return 0;
      });
      return sorted[0]?.f;
    }

    const sorted = mapped.sort((a, b) => b.photoPixels - a.photoPixels);
    return sorted[0]?.f;
  }

  const targetPixels =
    typeof preset === "number" ? preset * 1_000_000 : undefined;

  const scored = formats
    .map((f) => {
      const w = Number(f?.photoWidth ?? 0);
      const h = Number(f?.photoHeight ?? 0);
      const pixels = w * h;
      const mp = pixels / 1_000_000;
      const aspectPenalty = getAspectPenalty(w, h);
      const smallPenalty =
        mp < minRecommendedMP ? (minRecommendedMP - mp) * 5 : 0;

      let targetPenalty = 0;
      if (typeof targetPixels === "number" && Number.isFinite(targetPixels)) {
        const diff = pixels - targetPixels;
        targetPenalty =
          diff >= 0 ? diff / targetPixels : Math.abs(diff) / targetPixels + 2;
      } else if (preset === "auto") {
        // Auto: prefer higher MP but with aspect ratio consideration
        targetPenalty = -mp;
      }
      const fpsPenalty = typeof f?.maxFps === "number" && f.maxFps < 30 ? 2 : 0;

      return {
        f,
        score: aspectPenalty * 2 + smallPenalty + targetPenalty + fpsPenalty,
        mp,
      };
    })
    .sort((a, b) => a.score - b.score);

  return scored[0]?.f;
};

// Standard phone megapixel values (S24 ultra, OnePlus Nord 3)
const STANDARD_MP_VALUES = [12, 24, 48, 50, 108, 200];

const getAvailableMegapixelBuckets = (formats: any[]) => {
  const buckets = new Set<number>();
  for (const f of formats ?? []) {
    const mp = calcMegapixels(f?.photoWidth, f?.photoHeight);
    if (!mp) continue;
    if (mp < 5) continue;
    const rounded = Math.round(mp);
    // Only include if it matches a standard phone MP value (within ±2 tolerance)
    const matchedStandard = STANDARD_MP_VALUES.find(
      (std) => Math.abs(rounded - std) <= 2,
    );
    if (matchedStandard) buckets.add(matchedStandard);
    else buckets.add(rounded);
  }
  return Array.from(buckets).sort((a, b) => a - b);
};

const CameraScreen: React.FC<CameraScreenProps> = ({
  visible,
  onClose,
  lots,
  setLots,
  activeLotIdx,
  setActiveLotIdx,
  onAutoSave,
  enhanceImages = false,
  onEnhanceChange,
}) => {
  const insets = useSafeAreaInsets();

  // react-native-vision-camera permissions
  const {
    hasPermission: hasCameraPermission,
    requestPermission: requestCameraPermission,
  } = useCameraPermission();
  const {
    hasPermission: hasMicPermission,
    requestPermission: requestMicPermission,
  } = useMicrophonePermission();
  const [mediaPermission, requestMediaPermission] =
    MediaLibrary.usePermissions();

  // Camera ref and device
  const cameraRef = useRef<Camera>(null);

  // Use Triple-Camera (multi-cam) for best quality and smooth zoom transitions
  // This enables ultra-wide (0.5x) + wide (1x) + telephoto (3x) switching
  const deviceMulti = useCameraDevice("back", {
    physicalDevices: [
      "ultra-wide-angle-camera",
      "wide-angle-camera",
      "telephoto-camera",
    ],
  });

  const deviceWide = useCameraDevice("back", {
    physicalDevices: ["wide-angle-camera"],
  });

  // Fallback for devices without all requested physical cameras (e.g. no telephoto)
  const deviceDefault = useCameraDevice("back");

  // Get ALL available camera devices to find the one with highest resolution
  const allDevices = useCameraDevices();

  const [maxResolutionMode, setMaxResolutionMode] = useState(true);
  const [resolutionPreset, setResolutionPreset] =
    useState<ResolutionPreset>("max");
  const didForceWideForLowResRef = useRef(false);

  const zoomPresetLockUntilRef = useRef(0);
  const suppressAutoModeUntilRef = useRef(0);
  const macroModeRef = useRef(false);

  // Track camera initialization state for first-install scenario
  const [cameraInitAttempts, setCameraInitAttempts] = useState(0);
  const [cameraInitTimedOut, setCameraInitTimedOut] = useState(false);
  const cameraInitIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Find the absolute best device for max resolution by checking ALL devices
  const bestHighResDevice = useMemo(() => {
    if (!allDevices || allDevices.length === 0) return undefined;

    let bestDevice: CameraDevice | undefined;
    let bestPixels = 0;

    const scoreDevice = (dev: CameraDevice) => {
      const phys = Array.isArray((dev as any)?.physicalDevices)
        ? ((dev as any).physicalDevices as string[])
        : [];
      const hasWide = phys.includes("wide-angle-camera");
      const hasUltra = phys.includes("ultra-wide-angle-camera");
      const hasTele = phys.includes("telephoto-camera");
      const physLen = phys.length;
      return (
        (hasWide ? 100 : 0) +
        (physLen === 1 ? 10 : 0) +
        (hasUltra ? -1 : 0) +
        (hasTele ? -1 : 0)
      );
    };

    for (const dev of allDevices) {
      if (dev.position !== "back") continue; // Only back cameras
      for (const fmt of dev.formats ?? []) {
        const pixels = (fmt.photoWidth ?? 0) * (fmt.photoHeight ?? 0);
        if (pixels > bestPixels) {
          bestPixels = pixels;
          bestDevice = dev;
        } else if (pixels === bestPixels && bestDevice) {
          if (scoreDevice(dev) > scoreDevice(bestDevice)) {
            bestDevice = dev;
          }
        }
      }
    }

    if (bestDevice) {
      console.log(
        `[Camera] Best high-res device: ${bestDevice.id}, max pixels: ${bestPixels} (${(bestPixels / 1_000_000).toFixed(1)}MP)`,
      );
    }
    return bestDevice;
  }, [allDevices]);

  // Log all available formats on mount for debugging
  useEffect(() => {
    if (!visible || !allDevices) return;

    console.log("[Camera] === ALL AVAILABLE DEVICES AND FORMATS ==");
    for (const dev of allDevices) {
      if (dev.position !== "back") continue;
      const formats = dev.formats ?? [];
      const maxFmt = formats.reduce((best, f) => {
        const pixels = (f.photoWidth ?? 0) * (f.photoHeight ?? 0);
        const bestPixels = (best?.photoWidth ?? 0) * (best?.photoHeight ?? 0);
        return pixels > bestPixels ? f : best;
      }, formats[0]);

      console.log(`[Camera] Device: ${dev.id} (${dev.name})`);
      console.log(
        `[Camera]   Physical: ${(dev as any).physicalDevices?.join(", ") || "N/A"}`,
      );
      console.log(
        `[Camera]   Max photo: ${maxFmt?.photoWidth}x${maxFmt?.photoHeight} (${(((maxFmt?.photoWidth ?? 0) * (maxFmt?.photoHeight ?? 0)) / 1_000_000).toFixed(1)}MP)`,
      );
      console.log(`[Camera]   Total formats: ${formats.length}`);
    }
    console.log("[Camera] === END DEVICES ==");
  }, [visible, allDevices]);

  // Some Android devices expose a low-res multi-cam logical device for photos (e.g. ~3MP).
  // If we detect that the multi/default device can't do reasonable MP, auto-switch to wide once.
  const deviceMultiMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceMulti?.formats ?? []),
    [deviceMulti?.formats],
  );
  const deviceDefaultMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceDefault?.formats ?? []),
    [deviceDefault?.formats],
  );
  const deviceWideMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceWide?.formats ?? []),
    [deviceWide?.formats],
  );

  const bestDeviceForMaxRes = useMemo(() => {
    const candidates: Array<{ dev: any; mp: number }> = [];
    if (deviceWide && typeof deviceWideMaxMP === "number") {
      candidates.push({ dev: deviceWide, mp: deviceWideMaxMP });
    }
    if (deviceMulti && typeof deviceMultiMaxMP === "number") {
      candidates.push({ dev: deviceMulti, mp: deviceMultiMaxMP });
    }
    if (deviceDefault && typeof deviceDefaultMaxMP === "number") {
      candidates.push({ dev: deviceDefault, mp: deviceDefaultMaxMP });
    }
    candidates.sort((a, b) => b.mp - a.mp);
    return candidates[0]?.dev;
  }, [
    deviceDefault,
    deviceDefaultMaxMP,
    deviceMulti,
    deviceMultiMaxMP,
    deviceWide,
    deviceWideMaxMP,
  ]);

  useEffect(() => {
    if (!deviceWide || !deviceWideMaxMP) return;

    const candidateMP = deviceMultiMaxMP ?? deviceDefaultMaxMP ?? 0;
    // If the chosen logical device tops out below ~8MP (or doesn't report), but wide can do 10MP+, force wide.
    const wantsHighResPreset =
      resolutionPreset === "max" ||
      (typeof resolutionPreset === "number" && resolutionPreset >= 48);

    if (Date.now() < suppressAutoModeUntilRef.current) return;

    if (
      !maxResolutionMode &&
      !macroModeRef.current &&
      ((candidateMP < 8 && deviceWideMaxMP >= 10) ||
        (wantsHighResPreset && deviceWideMaxMP > candidateMP + 2))
    ) {
      setMaxResolutionMode(true);
    }
  }, [
    deviceDefaultMaxMP,
    deviceMultiMaxMP,
    deviceWide,
    deviceWideMaxMP,
    maxResolutionMode,
    resolutionPreset,
  ]);

  // For max resolution mode, prefer bestHighResDevice (scans ALL devices) over other options
  const device = useMemo(() => {
    console.log(
      `[Camera] Device selection: maxResMode=${maxResolutionMode}, preset=${resolutionPreset}`,
    );
    console.log(
      `[Camera]   bestHighResDevice=${bestHighResDevice?.id ?? "null"}, deviceWide=${deviceWide?.id ?? "null"}`,
    );

    if (maxResolutionMode && resolutionPreset === "max") {
      // Priority: bestHighResDevice > deviceWide > bestDeviceForMaxRes > deviceDefault
      if (bestHighResDevice) {
        console.log(
          `[Camera] SELECTED bestHighResDevice: ${bestHighResDevice.id}`,
        );
        return bestHighResDevice;
      }
      if (deviceWide) {
        console.log(`[Camera] SELECTED deviceWide: ${deviceWide.id}`);
        return deviceWide;
      }
      if (bestDeviceForMaxRes) {
        console.log(
          `[Camera] SELECTED bestDeviceForMaxRes: ${bestDeviceForMaxRes.id}`,
        );
        return bestDeviceForMaxRes;
      }
    } else if (maxResolutionMode) {
      if (deviceWide && typeof deviceWideMaxMP !== "number") {
        console.log(
          `[Camera] SELECTED deviceWide (maxRes/noMP): ${deviceWide.id}`,
        );
        return deviceWide;
      }
      if (
        deviceWide &&
        typeof deviceWideMaxMP === "number" &&
        deviceWideMaxMP >= (deviceMultiMaxMP ?? 0) &&
        deviceWideMaxMP >= (deviceDefaultMaxMP ?? 0)
      ) {
        console.log(`[Camera] SELECTED deviceWide (maxRes): ${deviceWide.id}`);
        return deviceWide;
      }
      const selected = bestDeviceForMaxRes ?? deviceDefault;
      console.log(`[Camera] SELECTED fallback: ${selected?.id ?? "null"}`);
      return selected;
    }
    const selected = deviceMulti ?? deviceDefault;
    console.log(`[Camera] SELECTED multi/default: ${selected?.id ?? "null"}`);
    return selected;
  }, [
    maxResolutionMode,
    resolutionPreset,
    bestHighResDevice,
    deviceWide,
    deviceWideMaxMP,
    deviceMultiMaxMP,
    deviceDefaultMaxMP,
    bestDeviceForMaxRes,
    deviceMulti,
    deviceDefault,
  ]);

  // Camera initialization retry mechanism for first-install scenario
  // On first install, camera hooks may take a few seconds to initialize after permissions are granted
  useEffect(() => {
    // Only run if visible, has permission, but no device yet
    if (!visible || !hasCameraPermission || device || cameraInitTimedOut) {
      // Clear interval if device becomes available or modal closes
      if (cameraInitIntervalRef.current) {
        clearInterval(cameraInitIntervalRef.current);
        cameraInitIntervalRef.current = null;
      }
      return;
    }

    console.log(`[Camera] No device yet, attempt ${cameraInitAttempts + 1}/10`);

    // Start retry interval if not already running
    if (!cameraInitIntervalRef.current) {
      cameraInitIntervalRef.current = setInterval(() => {
        setCameraInitAttempts((prev) => {
          const next = prev + 1;
          console.log(`[Camera] Retry attempt ${next}/10`);
          if (next >= 10) {
            // After 5 seconds (10 attempts at 500ms), give up
            console.warn(
              "[Camera] Camera initialization timed out after 5 seconds",
            );
            setCameraInitTimedOut(true);
            if (cameraInitIntervalRef.current) {
              clearInterval(cameraInitIntervalRef.current);
              cameraInitIntervalRef.current = null;
            }
          }
          return next;
        });
      }, 500);
    }

    return () => {
      if (cameraInitIntervalRef.current) {
        clearInterval(cameraInitIntervalRef.current);
        cameraInitIntervalRef.current = null;
      }
    };
  }, [
    visible,
    hasCameraPermission,
    device,
    cameraInitAttempts,
    cameraInitTimedOut,
  ]);

  // Reset camera init state when modal opens
  useEffect(() => {
    if (visible) {
      setCameraInitAttempts(0);
      setCameraInitTimedOut(false);
    }
  }, [visible]);

  // Log when device changes - this is the ACTUAL device being used
  useEffect(() => {
    if (device) {
      const maxFmt = (device.formats ?? []).reduce((best: any, f: any) => {
        const pixels = (f.photoWidth ?? 0) * (f.photoHeight ?? 0);
        const bestPixels = (best?.photoWidth ?? 0) * (best?.photoHeight ?? 0);
        return pixels > bestPixels ? f : best;
      }, null);
      console.log(
        `[Camera] *** ACTIVE DEVICE: ${device.id} (${device.name}) ***`,
      );
      console.log(
        `[Camera] *** MAX FORMAT: ${maxFmt?.photoWidth}x${maxFmt?.photoHeight} (${(((maxFmt?.photoWidth ?? 0) * (maxFmt?.photoHeight ?? 0)) / 1_000_000).toFixed(1)}MP) ***`,
      );
    }
  }, [device]);

  const minZoom = useMemo(
    () =>
      maxResolutionMode ? (device?.neutralZoom ?? 1) : (device?.minZoom ?? 1),
    [device, maxResolutionMode],
  );
  const maxZoom = useMemo(() => device?.maxZoom ?? 1, [device]);
  const neutralZoom = useMemo(() => device?.neutralZoom ?? 1, [device]);
  // Start at 1x (neutralZoom)
  const zoom = useSharedValue(neutralZoom);
  const pinchStartZoom = useSharedValue(neutralZoom);
  const lastZoomReported = useSharedValue(neutralZoom);
  const [currentZoom, setCurrentZoom] = useState(neutralZoom);

  // Available zoom presets based on device capabilities
  const zoomPresets = useMemo(() => {
    const presets: { label: string; value: number }[] = [];
    const physicalDevices = (device as any)?.physicalDevices as
      | string[]
      | undefined;
    const hasUltraWide =
      !maxResolutionMode &&
      (physicalDevices?.includes("ultra-wide-angle-camera") ||
        neutralZoom > minZoom + 0.05);
    const hasTelephoto = physicalDevices?.includes("telephoto-camera");

    // Ultra-wide (device minZoom)
    if (hasUltraWide && minZoom < neutralZoom) {
      presets.push({ label: "UW", value: minZoom });
    }

    // Standard 1x (neutralZoom)
    presets.push({ label: "1x", value: neutralZoom });

    // 2x zoom (if available)
    const twoX = neutralZoom * 2;
    if (maxZoom >= twoX) {
      presets.push({ label: "2x", value: twoX });
    }

    // 3x zoom (telephoto or digital)
    const threeX = neutralZoom * 3;
    if (hasTelephoto || maxZoom >= threeX) {
      presets.push({ label: "3x", value: Math.min(threeX, maxZoom) });
    }

    // 5x zoom if available
    const fiveX = neutralZoom * 5;
    if (maxZoom >= fiveX) {
      presets.push({ label: "5x", value: fiveX });
    }

    return presets;
  }, [device, minZoom, maxResolutionMode, maxZoom, neutralZoom]);

  // Set zoom level with animation feel
  const setZoomLevel = useCallback(
    (level: number) => {
      const clamped = Math.max(minZoom, Math.min(level, maxZoom));
      zoom.value = clamped;
      pinchStartZoom.value = clamped;
      lastZoomReported.value = clamped;
      setCurrentZoom(clamped);
      // Haptic feedback
      if (Platform.OS === "ios") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Vibration.vibrate(15);
      }
    },
    [minZoom, maxZoom, pinchStartZoom, zoom, lastZoomReported],
  );

  const lastZoomUiUpdateRef = useRef(0);
  const syncCurrentZoomFromUi = useCallback((z: number) => {
    const now = Date.now();
    if (now - lastZoomUiUpdateRef.current < 120) return;
    lastZoomUiUpdateRef.current = now;
    setCurrentZoom(z);
  }, []);

  useAnimatedReaction(
    () => zoom.value,
    (z) => {
      if (Math.abs(z - lastZoomReported.value) >= 0.02) {
        lastZoomReported.value = z;
        runOnJS(syncCurrentZoomFromUi)(z);
      }
    },
    [],
  );

  const cameraAnimatedProps = useAnimatedProps<CameraProps>(() => {
    const z = Math.max(Math.min(zoom.value, maxZoom), minZoom);
    return { zoom: z };
  }, [maxZoom, minZoom]);

  const accelMagnitudeRef = useRef<number | null>(null);
  const accelMotionRef = useRef(0);
  const accelStableSinceRef = useRef<number | null>(null);
  const accelAvailableRef = useRef(false);
  const Accelerometer = useMemo(() => {
    try {
      const req = (0, eval)("require") as (id: string) => any;
      const sensors = req?.("expo-sensors");
      const accel = sensors?.Accelerometer;
      if (!accel) return null;
      return accel as {
        setUpdateInterval: (ms: number) => void;
        addListener: (
          cb: (data: { x: number; y: number; z: number }) => void,
        ) => {
          remove: () => void;
        };
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (!Accelerometer) return;

    let subscription: { remove: () => void } | null = null;

    try {
      accelAvailableRef.current = true;
      accelMagnitudeRef.current = null;
      accelMotionRef.current = 0;
      accelStableSinceRef.current = null;

      Accelerometer.setUpdateInterval(50);
      subscription = Accelerometer.addListener(({ x, y, z }) => {
        const mag = Math.sqrt(x * x + y * y + z * z);
        const prev = accelMagnitudeRef.current;
        accelMagnitudeRef.current = mag;

        if (typeof prev === "number") {
          const delta = Math.abs(mag - prev);
          const filtered = accelMotionRef.current * 0.85 + delta * 0.15;
          accelMotionRef.current = filtered;

          if (filtered < 0.008) {
            if (accelStableSinceRef.current === null)
              accelStableSinceRef.current = Date.now();
          } else {
            accelStableSinceRef.current = null;
          }
        }
      });
    } catch {
      accelAvailableRef.current = false;
      accelStableSinceRef.current = null;
      accelMagnitudeRef.current = null;
      accelMotionRef.current = 0;
      subscription = null;
    }

    return () => {
      accelAvailableRef.current = false;
      accelStableSinceRef.current = null;
      accelMagnitudeRef.current = null;
      accelMotionRef.current = 0;
      subscription?.remove?.();
    };
  }, [visible, Accelerometer]);

  const waitForDeviceSteady = useCallback(async (maxWaitMs: number) => {
    if (!accelAvailableRef.current) return;

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const stableSince = accelStableSinceRef.current;
      if (stableSince !== null && Date.now() - stableSince >= 140) return;
      await new Promise<void>((r) => setTimeout(r, 30));
    }
  }, []);

  // Screen dimensions for orientation
  const [dimensions, setDimensions] = useState(Dimensions.get("window"));
  const isLandscape = dimensions.width > dimensions.height;

  // Camera settings - Professional grade for iPhone 16 Pro Max / Samsung S24
  const [flash, setFlash] = useState<FlashMode>("off");
  const [focusOn, setFocusOn] = useState(true); // Auto-focus on by default
  const [capturing, setCapturing] = useState(false);
  const [exposure, setExposure] = useState(-1); // Neutral exposure for faster shutter speed
  const enableHdr = false; // HDR disabled - causes motion blur and slow capture
  const [performanceMode, setPerformanceMode] =
    useState<CameraPerformanceMode>("quality");
  const [enhanceOn, setEnhanceOn] = useState(enhanceImages);
  const [editingPhotoUri, setEditingPhotoUri] = useState<string | null>(null);

  // Low-light boost and portrait mode
  const [lowLightBoost, setLowLightBoost] = useState(false);
  const [portraitMode, setPortraitMode] = useState(false);
  const [macroMode, setMacroMode] = useState(false);

  useEffect(() => {
    macroModeRef.current = macroMode;
  }, [macroMode]);

  const canUseMacro = useMemo(() => {
    if (maxResolutionMode) return false;
    const minZ = device?.minZoom ?? 1;
    const neutralZ = device?.neutralZoom ?? 1;
    return minZ < neutralZ - 0.05;
  }, [device?.minZoom, device?.neutralZoom, maxResolutionMode]);

  useEffect(() => {
    if (!visible) return;
    if (!macroMode) return;
    if (maxResolutionMode) {
      setMacroMode(false);
      return;
    }

    if (!canUseMacro) {
      setMacroMode(false);
      return;
    }

    const target = device?.minZoom ?? 1;
    const clamped = Math.max(
      device?.minZoom ?? 1,
      Math.min(target, device?.maxZoom ?? target),
    );
    zoom.value = clamped;
    pinchStartZoom.value = clamped;
    lastZoomReported.value = clamped;
    setCurrentZoom(clamped);
  }, [
    visible,
    maxResolutionMode,
    macroMode,
    canUseMacro,
    device?.minZoom,
    device?.maxZoom,
    zoom,
    pinchStartZoom,
    lastZoomReported,
  ]);

  const [lastCaptureInfo, setLastCaptureInfo] = useState<{
    uri?: string;
    width?: number;
    height?: number;
    megapixels?: number;
  } | null>(null);

  const toggleMaxResolutionMode = useCallback(() => {
    setMaxResolutionMode(true);
  }, []);

  const applyResolutionPreset = useCallback((_preset: ResolutionPreset) => {
    setResolutionPreset("max");
    setMaxResolutionMode(true);
  }, []);

  const getImageMetaAsync = useCallback(async (uri: string) => {
    return await new Promise<{
      width?: number;
      height?: number;
      megapixels?: number;
    }>((resolve) => {
      Image.getSize(
        uri,
        (width, height) => {
          resolve({ width, height, megapixels: calcMegapixels(width, height) });
        },
        () => resolve({}),
      );
    });
  }, []);

  const updatePhotoAdjustments = useCallback(
    (
      uri: string,
      adjustments: {
        contrast: number;
        saturation: number;
        sharpness: number;
        detail: number;
      },
    ) => {
      setLots((prev) => {
        const updated = [...prev];
        const lot = updated[activeLotIdx];
        if (!lot) return prev;

        const patch = (p: PhotoFile): PhotoFile =>
          p.uri === uri
            ? {
                ...p,
                adjustments,
              }
            : p;

        updated[activeLotIdx] = {
          ...lot,
          files: lot.files.map(patch),
          extraFiles: lot.extraFiles.map(patch),
        };
        return updated;
      });
    },
    [activeLotIdx, setLots],
  );

  // Sync enhanceOn with parent when it changes
  useEffect(() => {
    setEnhanceOn(enhanceImages);
  }, [enhanceImages]);

  const toggleEnhance = useCallback(() => {
    const newValue = !enhanceOn;
    setEnhanceOn(newValue);
    onEnhanceChange?.(newValue);
  }, [enhanceOn, onEnhanceChange]);

  // Low-light boost toggle
  const toggleLowLightBoost = useCallback(() => {
    setLowLightBoost((prev) => !prev);
  }, []);

  // Portrait mode toggle (depth data)
  const togglePortraitMode = useCallback(() => {
    setPortraitMode((prev) => !prev);
  }, []);

  const saveToGallery = useCallback(
    (uri: string) => {
      if (!mediaPermission?.granted) {
        console.warn("[Camera] Cannot save to gallery: no permission");
        return;
      }
      console.log(`[Camera] Saving to gallery: ${uri.slice(-50)}`);
      MediaLibrary.saveToLibraryAsync(uri)
        .then(() => console.log("[Camera] Saved to gallery successfully"))
        .catch((e) =>
          console.warn(
            "[Camera] Failed to save to gallery:",
            uri.slice(-50),
            e,
          ),
        );
    },
    [mediaPermission?.granted],
  );

  // Default zoom behavior:
  // - We want ~0.6x by default (close to ultra-wide)
  // - But we also want to keep native pinch-to-zoom enabled
  // Strategy: set an initial zoom value, then release it after onInitialized.
  const [initialZoom, setInitialZoom] = useState<number | undefined>(undefined);
  const didReleaseInitialZoomRef = useRef(false);

  const handleCameraInitialized = useCallback(() => {
    if (didReleaseInitialZoomRef.current) return;
    didReleaseInitialZoomRef.current = true;

    if (device && !maxResolutionMode && macroMode) {
      const minZ = device.minZoom ?? 1;
      const neutralZ = device.neutralZoom ?? 1;
      const hasUltraWide = minZ < neutralZ;

      if (hasUltraWide) {
        setTimeout(() => {
          zoom.value = minZ;
          setCurrentZoom(minZ);
          pinchStartZoom.value = minZ;
          lastZoomReported.value = minZ;
        }, 200);
      }
    }

    // Release initialZoom control
    setTimeout(() => {
      setInitialZoom(undefined);
    }, 400);
  }, [
    device,
    lastZoomReported,
    maxResolutionMode,
    macroMode,
    pinchStartZoom,
    zoom,
  ]);

  const toggleMacroMode = useCallback(() => {
    setMacroMode((prev) => {
      const next = !prev;
      if (next) {
        if (canUseMacro && !maxResolutionMode) setZoomLevel(minZoom);
      } else {
        setZoomLevel(neutralZoom);
      }
      return next;
    });
  }, [canUseMacro, maxResolutionMode, minZoom, neutralZoom, setZoomLevel]);

  const handleZoomPresetPress = useCallback(
    (preset: { label: string; value: number }) => {
      const now = Date.now();
      if (now < zoomPresetLockUntilRef.current) return;
      zoomPresetLockUntilRef.current = now + 450;
      suppressAutoModeUntilRef.current = now + 1200;

      if (preset.label === "UW") {
        if (canUseMacro && !macroMode) setMacroMode(true);
      } else {
        if (macroMode) setMacroMode(false);
      }
      setZoomLevel(preset.value);
    },
    [canUseMacro, macroMode, setZoomLevel],
  );

  useEffect(() => {
    if (!visible) return;
    didReleaseInitialZoomRef.current = false;

    if (device) {
      const neutralZ = device.neutralZoom ?? 1;
      setInitialZoom(neutralZ);
      zoom.value = neutralZ;
      setCurrentZoom(neutralZ);
      pinchStartZoom.value = neutralZ;
      lastZoomReported.value = neutralZ;
    }
  }, [visible, device, zoom, pinchStartZoom, lastZoomReported]);

  useEffect(() => {
    if (initialZoom !== undefined) {
      zoom.value = initialZoom;
      setCurrentZoom(initialZoom);
    }
  }, [initialZoom, zoom]);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [forceVideoUseCase, setForceVideoUseCase] = useState(false);

  const enableVideoUseCase = useMemo(() => {
    if (Platform.OS !== "android") return true;
    return Boolean(forceVideoUseCase || isRecording);
  }, [forceVideoUseCase, isRecording]);

  const selectedFormat = useMemo(() => {
    if (!device?.formats) return undefined;

    const minMP = 10;
    const fmt = (() => {
      if (Platform.OS !== "android" || resolutionPreset !== "max") {
        return pickBestPhotoFormat(device.formats, resolutionPreset, minMP);
      }

      if (!enableVideoUseCase) {
        return (device.formats ?? []).reduce((best: any, f: any) => {
          const pixels = (f?.photoWidth ?? 0) * (f?.photoHeight ?? 0);
          const bestPixels = (best?.photoWidth ?? 0) * (best?.photoHeight ?? 0);
          return pixels > bestPixels ? f : best;
        }, null);
      }

      return (device.formats ?? []).reduce((best: any, f: any) => {
        const pixels = (f?.videoWidth ?? 0) * (f?.videoHeight ?? 0);
        const bestPixels = (best?.videoWidth ?? 0) * (best?.videoHeight ?? 0);
        return pixels > bestPixels ? f : best;
      }, null);
    })();

    // Log selected format for debugging
    if (fmt) {
      const photoMP = (
        ((fmt.photoWidth ?? 0) * (fmt.photoHeight ?? 0)) /
        1_000_000
      ).toFixed(1);
      const videoMP = (
        ((fmt.videoWidth ?? 0) * (fmt.videoHeight ?? 0)) /
        1_000_000
      ).toFixed(1);
      console.log(
        `[Camera] Selected format: photo=${fmt.photoWidth}x${fmt.photoHeight} (${photoMP}MP), video=${fmt.videoWidth}x${fmt.videoHeight} (${videoMP}MP)`,
      );
    }
    return fmt;
  }, [device?.formats, enableVideoUseCase, resolutionPreset]);

  // Log all formats available on the device for debugging
  useEffect(() => {
    if (!device?.formats || !visible) return;

    const formats = device.formats;
    const sorted = [...formats]
      .map((f) => ({ w: f.photoWidth ?? 0, h: f.photoHeight ?? 0 }))
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, 5); // Top 5 formats

    console.log(
      `[Camera] Device ${device.id} has ${formats.length} formats. Top 5:`,
    );
    sorted.forEach((f, i) => {
      console.log(
        `[Camera]   ${i + 1}. ${f.w}x${f.h} (${((f.w * f.h) / 1_000_000).toFixed(1)}MP)`,
      );
    });
  }, [device?.formats, device?.id, visible]);

  const format = selectedFormat;

  // Don't force FPS - let VisionCamera use the format's native FPS
  // High-res formats often have lower maxFps (e.g., 30fps)

  const cameraSessionKey = useMemo(() => {
    const id = String((device as any)?.id ?? "no-device");
    const w = String(format?.photoWidth ?? "no-w");
    const h = String(format?.photoHeight ?? "no-h");
    return `${id}-${w}x${h}-${performanceMode}`;
  }, [device, format?.photoHeight, format?.photoWidth, performanceMode]);

  const selectedFormatMP = useMemo(
    () => calcMegapixels(format?.photoWidth, format?.photoHeight),
    [format?.photoWidth, format?.photoHeight],
  );

  // Safety net: if we still ended up with a tiny selected format (e.g. ~3MP) and wide supports higher, switch.
  useEffect(() => {
    if (!deviceWideMaxMP) return;
    if (!selectedFormatMP) return;
    if (Date.now() < suppressAutoModeUntilRef.current) return;
    if (
      !maxResolutionMode &&
      !macroMode &&
      selectedFormatMP < 8 &&
      deviceWideMaxMP >= 10
    ) {
      setMaxResolutionMode(true);
    }
  }, [deviceWideMaxMP, selectedFormatMP, maxResolutionMode, macroMode]);

  const presetLabel = useMemo(() => {
    if (resolutionPreset === "auto") return "Auto";
    if (resolutionPreset === "max") return "Max";
    return `${resolutionPreset}MP`;
  }, [resolutionPreset]);

  const previewMP = useMemo(() => {
    if (!selectedFormatMP) return "—";
    return formatMegapixelsLabel(selectedFormatMP);
  }, [selectedFormatMP]);

  const enableBufferCompression = false;

  const photoQualityBalance = useMemo<
    CameraProps["photoQualityBalance"]
  >(() => {
    if (performanceMode === "speed") return "speed";
    if (performanceMode === "balanced") return "balanced";
    return "quality";
  }, [performanceMode]);

  const videoBitRate = useMemo<CameraProps["videoBitRate"]>(() => {
    if (!enableVideoUseCase) return undefined;
    return "high";
  }, [enableVideoUseCase]);

  useEffect(() => {
    if (!visible) return;
    applyResolutionPreset("max");
    AsyncStorage.getItem(CAMERA_PERFORMANCE_MODE_KEY)
      .then((v) => {
        if (v === "speed" || v === "balanced" || v === "quality") {
          setPerformanceMode(v);
        }
      })
      .catch(() => {});
  }, [visible, applyResolutionPreset]);

  useEffect(() => {
    AsyncStorage.setItem(CAMERA_PERFORMANCE_MODE_KEY, performanceMode).catch(
      () => {},
    );
  }, [performanceMode]);

  const setPerformance = useCallback(
    (mode: CameraPerformanceMode) => {
      if (isRecording || capturing) return;
      setPerformanceMode(mode);
    },
    [capturing, isRecording],
  );

  useEffect(() => {
    if (!visible) {
      setForceVideoUseCase(false);
      return;
    }
    setForceVideoUseCase(false);
  }, [visible]);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [selectedPreviewIdx, setSelectedPreviewIdx] = useState(0);

  // Tap-to-focus state
  const [tapFocusPoint, setTapFocusPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const tapFocusAnim = useRef(new Animated.Value(0)).current;
  const suppressFocusUntilRef = useRef(0);

  const cameraWrapperRef = useRef<View>(null);
  const [cameraWrapperOffset, setCameraWrapperOffset] = useState({
    x: 0,
    y: 0,
  });
  const optimizeQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Camera active state
  const [isCameraActive, setIsCameraActive] = useState(false);

  // Orientation handling
  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ window }) => {
      setDimensions(window);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (visible) {
      ScreenOrientation.unlockAsync();
      StatusBar.setHidden(true);
    } else {
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
      StatusBar.setHidden(false);
    }
    return () => {
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
      StatusBar.setHidden(false);
    };
  }, [visible]);

  // Request permissions
  useEffect(() => {
    if (visible) {
      const requestAllPermissions = async () => {
        if (!hasCameraPermission) await requestCameraPermission();
        if (!hasMicPermission) await requestMicPermission();
        if (!mediaPermission?.granted) await requestMediaPermission();
      };
      requestAllPermissions();
      setIsCameraActive(true);
    } else {
      setIsCameraActive(false);
    }
  }, [
    visible,
    hasCameraPermission,
    hasMicPermission,
    mediaPermission?.granted,
  ]);

  // Auto-create first lot when camera opens
  useEffect(() => {
    if (visible && lots.length === 0) {
      const newLot = createNewLot();
      setLots([newLot]);
      setActiveLotIdx(0);
    }
  }, [visible, lots.length]);

  // Reset state on open
  useEffect(() => {
    if (visible) {
      setIsRecording(false);
      setRecordingTime(0);
      setShowPreview(false);
    }
  }, [visible]);

  // Cleanup recording interval
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    };
  }, []);

  // Camera view dimensions for coordinate conversion
  const [cameraViewDimensions, setCameraViewDimensions] = useState({
    width: 0,
    height: 0,
  });
  const [focusBoxRect, setFocusBoxRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [portraitTopBarHeight, setPortraitTopBarHeight] = useState(96);
  const [portraitBottomBarHeight, setPortraitBottomBarHeight] = useState(240);
  const [landscapeTopBarHeight, setLandscapeTopBarHeight] = useState(72);
  const [landscapeRightPanelWidth, setLandscapeRightPanelWidth] = useState(120);
  const [landscapeRightPanelHeight, setLandscapeRightPanelHeight] = useState(0);

  const isLandscapeRightPanelTight = useMemo(
    () => landscapeRightPanelHeight > 0 && landscapeRightPanelHeight < 360,
    [landscapeRightPanelHeight],
  );

  const landscapeRightPanelControlHeights = useMemo(() => {
    const tight = isLandscapeRightPanelTight;

    const panelPaddingTop = Math.max(insets.top, 2);
    const panelPaddingBottom = Math.max(insets.bottom, 2);
    const panelContentHeight = Math.max(
      0,
      landscapeRightPanelHeight - panelPaddingTop - panelPaddingBottom,
    );

    const baseCapture = tight ? 24 : 28;
    const baseRecord = tight ? 16 : 18;
    const baseExtra = tight ? 12 : 14;
    const baseZoom = tight ? 16 : 18;
    const basePerformance = tight ? 16 : 18;
    const baseCameraMode = tight ? 18 : 20;
    const baseDone = tight ? 26 : 30;
    const baseDoneMarginTop = tight ? 1 : 2;

    const captureMul = 1.18;
    const recordMul = 0.92;
    const extraMul = 0.9;
    const zoomMul = 0.9;
    const performanceMul = 0.9;
    const cameraModeMul = 0.9;
    const doneMul = 0.9;

    const hasRecordExtras = Boolean(
      device?.supportsLowLightBoost || canUseMacro,
    );

    const groupGap = tight ? 2 : 3;
    const recordInternalGap = hasRecordExtras ? (tight ? 1 : 2) : 0;
    const zoomVerticalMargin = tight ? 0 : 2;

    const groupsCount = 7;
    const fixedVertical =
      Math.max(0, groupsCount - 1) * groupGap +
      recordInternalGap +
      zoomVerticalMargin +
      baseDoneMarginTop;

    const weightedControlsSum =
      3 * baseCapture * captureMul +
      baseRecord * recordMul +
      (hasRecordExtras ? baseExtra * extraMul : 0) +
      baseZoom * zoomMul +
      basePerformance * performanceMul +
      baseCameraMode * cameraModeMul +
      baseDone * doneMul;

    const availableForControls = Math.max(
      0,
      panelContentHeight - fixedVertical,
    );
    const rawScale =
      weightedControlsSum > 0 && availableForControls > 0
        ? availableForControls / weightedControlsSum
        : 1;
    const scale = Math.max(0.75, Math.min(10, rawScale));

    const round = (n: number) => Math.round(n);

    return {
      capture: round(baseCapture * captureMul * scale),
      record: round(baseRecord * recordMul * scale),
      extra: round(baseExtra * extraMul * scale),
      zoom: round(baseZoom * zoomMul * scale),
      performance: round(basePerformance * performanceMul * scale),
      cameraMode: round(baseCameraMode * cameraModeMul * scale),
      done: round(baseDone * doneMul * scale),
    };
  }, [
    canUseMacro,
    device?.supportsLowLightBoost,
    insets.bottom,
    insets.top,
    isLandscapeRightPanelTight,
    landscapeRightPanelHeight,
  ]);

  const portraitPreviewRect = useMemo(() => {
    const vw = cameraViewDimensions.width || dimensions.width;
    const vh = cameraViewDimensions.height || dimensions.height;

    let width = vw;
    let height = (vw * 4) / 3;

    if (height > vh) {
      height = vh;
      width = (vh * 3) / 4;
    }

    const left = Math.max(0, (vw - width) / 2);
    const top = Math.max(0, (vh - height) / 2);
    return { left, top, width, height };
  }, [
    cameraViewDimensions.height,
    cameraViewDimensions.width,
    dimensions.height,
    dimensions.width,
  ]);

  const handleCameraWrapperLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setCameraViewDimensions({ width, height });

    cameraWrapperRef.current?.measureInWindow((x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setCameraWrapperOffset({ x, y });
      }
    });
  }, []);

  const computeNormalizedFocusBox = useCallback(
    (
      imageWidth: number,
      imageHeight: number,
    ): { x: number; y: number; w: number; h: number } | null => {
      if (!focusOn || !focusBoxRect) return null;

      const previewLeft = !isLandscape ? portraitPreviewRect.left : 0;
      const previewTop = !isLandscape ? portraitPreviewRect.top : 0;
      const previewWidth = !isLandscape
        ? portraitPreviewRect.width
        : cameraViewDimensions.width || dimensions.width;
      const previewHeight = !isLandscape
        ? portraitPreviewRect.height
        : cameraViewDimensions.height || dimensions.height;

      if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight))
        return null;
      if (previewWidth <= 0 || previewHeight <= 0) return null;

      const boxLeft = Math.max(previewLeft, focusBoxRect.x);
      const boxTop = Math.max(previewTop, focusBoxRect.y);
      const boxRight = Math.min(
        previewLeft + previewWidth,
        focusBoxRect.x + focusBoxRect.width,
      );
      const boxBottom = Math.min(
        previewTop + previewHeight,
        focusBoxRect.y + focusBoxRect.height,
      );

      const intersectionW = boxRight - boxLeft;
      const intersectionH = boxBottom - boxTop;
      if (intersectionW < 8 || intersectionH < 8) return null;

      let normX = (boxLeft - previewLeft) / previewWidth;
      let normY = (boxTop - previewTop) / previewHeight;
      let normW = intersectionW / previewWidth;
      let normH = intersectionH / previewHeight;

      const imageLandscape = imageWidth >= imageHeight;
      const previewLandscape = previewWidth >= previewHeight;
      if (imageLandscape !== previewLandscape) {
        const tmpX = normX,
          tmpY = normY,
          tmpW = normW,
          tmpH = normH;
        normX = 1 - (tmpY + tmpH);
        normY = tmpX;
        normW = tmpH;
        normH = tmpW;
      }

      normX = Math.max(0, Math.min(1, normX));
      normY = Math.max(0, Math.min(1, normY));
      normW = Math.max(0, Math.min(1 - normX, normW));
      normH = Math.max(0, Math.min(1 - normY, normH));

      if (normW < 0.01 || normH < 0.01) return null;

      return { x: normX, y: normY, w: normW, h: normH };
    },
    [
      cameraViewDimensions.height,
      cameraViewDimensions.width,
      dimensions.height,
      dimensions.width,
      focusBoxRect,
      focusOn,
      isLandscape,
      portraitPreviewRect.height,
      portraitPreviewRect.left,
      portraitPreviewRect.top,
      portraitPreviewRect.width,
    ],
  );

  const isAllowedFocusTap = useCallback(
    (x: number, y: number, vw: number, vh: number) => {
      if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0)
        return true;

      if (!isLandscape) {
        if (portraitTopBarHeight > 0 && y <= portraitTopBarHeight) return false;
        if (portraitBottomBarHeight > 0 && y >= vh - portraitBottomBarHeight)
          return false;
        return true;
      }

      if (landscapeTopBarHeight > 0 && y <= landscapeTopBarHeight) return false;
      if (landscapeRightPanelWidth > 0 && x >= vw - landscapeRightPanelWidth)
        return false;
      return true;
    },
    [
      isLandscape,
      landscapeRightPanelWidth,
      landscapeTopBarHeight,
      portraitBottomBarHeight,
      portraitTopBarHeight,
    ],
  );

  // Tap-to-focus handler - Actually focuses the camera at the tap point
  const handleFocusAtPoint = useCallback(
    async (
      locationX: number,
      locationY: number,
      viewWidth?: number,
      viewHeight?: number,
    ) => {
      if (Date.now() < suppressFocusUntilRef.current) return;
      if (capturing) return;
      if (!focusOn) return;
      // Set focus point for visual indicator (screen coordinates)
      const vw = viewWidth || cameraViewDimensions.width || dimensions.width;
      const vh = viewHeight || cameraViewDimensions.height || dimensions.height;

      const x = Math.max(0, Math.min(locationX, vw));
      const y = Math.max(0, Math.min(locationY, vh));

      let previewLeft = 0;
      let previewTop = 0;
      let previewWidth = vw;
      let previewHeight = vh;

      if (!isLandscape) {
        previewLeft = portraitPreviewRect.left;
        previewTop = portraitPreviewRect.top;
        previewWidth = portraitPreviewRect.width;
        previewHeight = portraitPreviewRect.height;
      }

      if (
        x < previewLeft ||
        x > previewLeft + previewWidth ||
        y < previewTop ||
        y > previewTop + previewHeight
      ) {
        return;
      }

      if (!isAllowedFocusTap(x, y, vw, vh)) return;

      setTapFocusPoint({ x, y });
      // Only focus if camera is active and focus is enabled
      if (
        cameraRef.current &&
        device?.supportsFocus &&
        isCameraActive &&
        visible
      ) {
        try {
          // Use view dimensions for coordinate conversion if available
          // VisionCamera expects Point coordinates relative to the view
          // On Android, we need to ensure coordinates are within bounds
          const focusX = Math.max(0, Math.min(x - previewLeft, previewWidth));
          const focusY = Math.max(0, Math.min(y - previewTop, previewHeight));

          console.log(
            `[Camera] Focus at (${focusX.toFixed(0)}, ${focusY.toFixed(0)}) / view(${vw}x${vh})`,
          );
          await cameraRef.current.focus({ x: focusX, y: focusY });
        } catch (error) {
          // Focus may fail on some devices or if camera is busy, silently ignore
          console.log("[Camera] Focus failed:", error);
        }

        // Animate focus indicator - pulse effect then fade out
        tapFocusAnim.setValue(0);
        Animated.sequence([
          // Quickly appear
          Animated.timing(tapFocusAnim, {
            toValue: 1,
            duration: 100,
            useNativeDriver: true,
          }),
          // Pulse down
          Animated.timing(tapFocusAnim, {
            toValue: 0.7,
            duration: 150,
            useNativeDriver: true,
          }),
          // Pulse up
          Animated.timing(tapFocusAnim, {
            toValue: 1,
            duration: 150,
            useNativeDriver: true,
          }),
          // Hold visible
          Animated.delay(800),
          // Fade out
          Animated.timing(tapFocusAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ]).start(() => {
          setTapFocusPoint(null);
        });
      }
    },
    [
      capturing,
      focusOn,
      tapFocusAnim,
      device,
      cameraViewDimensions,
      dimensions,
      isLandscape,
      portraitPreviewRect,
      isAllowedFocusTap,
      isCameraActive,
      visible,
      suppressFocusUntilRef,
    ],
  );

  const pinchGesture = useMemo(() => {
    return Gesture.Pinch()
      .enabled(isCameraActive && visible)
      .onBegin(() => {
        pinchStartZoom.value = zoom.value;
      })
      .onUpdate((event: any) => {
        const scale = interpolate(
          event.scale,
          [1 - 1 / SCALE_FULL_ZOOM, 1, SCALE_FULL_ZOOM],
          [-1, 0, 1],
          Extrapolate.CLAMP,
        );
        zoom.value = interpolate(
          scale,
          [-1, 0, 1],
          [minZoom, pinchStartZoom.value, maxZoom],
          Extrapolate.CLAMP,
        );
      });
  }, [isCameraActive, visible, maxZoom, minZoom, pinchStartZoom, zoom]);

  const tapGesture = useMemo(() => {
    return Gesture.Tap()
      .enabled(
        focusOn && Platform.OS !== "android" && isCameraActive && visible,
      )
      .maxDuration(250)
      .onEnd((event: any) => {
        runOnJS(handleFocusAtPoint)(event.x, event.y);
      });
  }, [focusOn, handleFocusAtPoint, isCameraActive, visible]);

  const cameraGestures = useMemo(
    () => Gesture.Simultaneous(pinchGesture, tapGesture),
    [pinchGesture, tapGesture],
  );

  // Native touch handler for Android (more reliable than gesture handler)
  const handleCameraTouchEnd = useCallback(
    (event: GestureResponderEvent) => {
      if (!isCameraActive || !visible) return;
      if (!focusOn) return;
      const { pageX, pageY } = event.nativeEvent;
      const vw = cameraViewDimensions.width || dimensions.width;
      const vh = cameraViewDimensions.height || dimensions.height;
      const locationX = pageX - cameraWrapperOffset.x;
      const locationY = pageY - cameraWrapperOffset.y;
      handleFocusAtPoint(locationX, locationY, vw, vh);
    },
    [
      cameraViewDimensions.height,
      cameraViewDimensions.width,
      cameraWrapperOffset.x,
      cameraWrapperOffset.y,
      dimensions.height,
      dimensions.width,
      focusOn,
      handleFocusAtPoint,
      isCameraActive,
      visible,
    ],
  );

  useEffect(() => {
    if (!focusOn) return;
    if (!isCameraActive || !visible) return;
    if (!cameraRef.current || !device?.supportsFocus) return;

    const vw = isLandscape
      ? cameraViewDimensions.width || dimensions.width
      : portraitPreviewRect.width;
    const vh = isLandscape
      ? cameraViewDimensions.height || dimensions.height
      : portraitPreviewRect.height;

    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0)
      return;

    const t = setTimeout(() => {
      cameraRef.current?.focus({ x: vw / 2, y: vh / 2 }).catch(() => undefined);
    }, 450);

    return () => clearTimeout(t);
  }, [
    cameraViewDimensions.height,
    cameraViewDimensions.width,
    device?.supportsFocus,
    dimensions.height,
    dimensions.width,
    focusOn,
    isCameraActive,
    isLandscape,
    portraitPreviewRect.height,
    portraitPreviewRect.width,
    visible,
  ]);

  const queueAutoOptimizePhoto = useCallback(
    (
      _photo: { uri: string; name: string; type: string },
      _lotId: string,
      _isExtra: boolean,
    ) => {
      // API optimization is intentionally disabled in this sample app build.
      // This keeps camera capture flow working without backend API/config dependencies.
      return;
    },
    [],
  );

  const handlePrevLot = useCallback(() => {
    if (activeLotIdx > 0) {
      setActiveLotIdx(activeLotIdx - 1);
    }
  }, [activeLotIdx, setActiveLotIdx]);

  const handleNextLot = useCallback(() => {
    if (activeLotIdx < lots.length - 1) {
      setActiveLotIdx(activeLotIdx + 1);
    } else {
      // Create new lot
      const newLot = createNewLot();
      setLots((prev) => [...prev, newLot]);
      setActiveLotIdx(lots.length);
    }
  }, [activeLotIdx, lots.length, setActiveLotIdx, setLots]);

  const handleCapture = useCallback(
    async (mode: CaptureMode, isExtra: boolean) => {
      if (!cameraRef.current) return;
      if (capturing) return;
      suppressFocusUntilRef.current = Date.now() + 400;
      // Both modes now use fire-and-forget - no blocking needed

      const currentLot = lots[activeLotIdx];
      if (currentLot?.mode && currentLot.mode !== mode && !isExtra) {
        Alert.alert(
          "Mode Mismatch",
          `This lot uses "${currentLot.mode === "single_lot" ? "Bundle" : currentLot.mode === "per_item" ? "Per Item" : "Per Photo"}" mode. Use Extra or go to next lot.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "New Lot", onPress: handleNextLot },
          ],
        );
        return;
      }

      // QUALITY MODE: Full native quality burst capture - fire-and-forget
      // Uses takePhoto for 100% native sensor quality, no loading/blocking
      // Quick haptic (non-blocking)
      if (Platform.OS === "ios") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Haptics.selectionAsync();
      }

      // Fire-and-forget capture with full native quality using VisionCamera
      const captureId = Date.now();
      const targetLotId = currentLot?.id;
      console.log(
        `[Camera] enableVideoUseCase=${String(enableVideoUseCase)} forceVideoUseCase=${String(forceVideoUseCase)} isRecording=${String(isRecording)}`,
      );
      console.log(
        `[Camera] Taking photo with format: ${format?.photoWidth}x${format?.photoHeight}`,
      );
      const camera = cameraRef.current;
      const captureDelayMs = Platform.OS === "android" ? 120 : 50;
      const doCapture = async () => {
        const neutralZ = device?.neutralZoom ?? 1;
        const steadyWaitMs =
          Platform.OS === "android"
            ? currentZoom >= neutralZ * 1.8
              ? 650
              : 450
            : 0;
        if (steadyWaitMs > 0) await waitForDeviceSteady(steadyWaitMs);

        camera
          .takePhoto({
            flash: "off", // Torch is always on when flash='on', so no need for flash during capture
            enableShutterSound: false,
          })
          .then(async (photo) => {
            const photoUri = `file://${photo.path}`;

            // VisionCamera returns actual dimensions in photo object
            const visionWidth = photo.width;
            const visionHeight = photo.height;
            const visionMP = (visionWidth * visionHeight) / 1_000_000;

            console.log(
              `[Camera] CAPTURED: ${visionWidth}x${visionHeight} = ${visionMP.toFixed(1)}MP`,
            );

            // Use raw photo directly - no processing for best quality and speed
            const meta = {
              width: visionWidth,
              height: visionHeight,
              megapixels: visionMP,
            };

            const focusBox = computeNormalizedFocusBox(
              visionWidth,
              visionHeight,
            );

            if (
              Platform.OS === "android" &&
              !maxResolutionMode &&
              !macroMode &&
              !didForceWideForLowResRef.current &&
              typeof meta.megapixels === "number" &&
              meta.megapixels < 8 &&
              (deviceWideMaxMP ?? 0) >= 10
            ) {
              didForceWideForLowResRef.current = true;
              setMaxResolutionMode(true);
            }
            const modeLabel =
              mode === "single_lot"
                ? "bundle"
                : mode === "per_item"
                  ? "item"
                  : "photo";
            const extraLabel = isExtra ? "-extra" : "";
            const fileName = `lot-${activeLotIdx + 1}-${modeLabel}${extraLabel}-${captureId}.jpg`;
            const newPhoto: PhotoFile = {
              uri: photoUri,
              name: fileName,
              type: "image/jpeg",
              width: meta.width,
              height: meta.height,
              megapixels: meta.megapixels,
              focusBox: focusBox ?? undefined,
            };

            setLots((prev) => {
              const updated = [...prev];
              const lot = updated[activeLotIdx];
              if (!lot) return prev;
              if (isExtra) {
                updated[activeLotIdx] = {
                  ...lot,
                  extraFiles: [newPhoto, ...lot.extraFiles],
                };
              } else {
                updated[activeLotIdx] = {
                  ...lot,
                  mode: mode,
                  files: [newPhoto, ...lot.files],
                };
              }
              return updated;
            });

            // Save to media library (fire-and-forget)
            saveToGallery(photoUri);
            setLastCaptureInfo({ uri: photoUri, ...meta });
            setEditingPhotoUri(photoUri);
            onAutoSave?.();

            if (enhanceOn && targetLotId) {
              queueAutoOptimizePhoto(newPhoto, targetLotId, isExtra);
            }
          })
          .catch((e) => console.warn("Quality capture error:", e));
      };

      if (captureDelayMs > 0) {
        setTimeout(() => {
          void doCapture();
        }, captureDelayMs);
      } else {
        void doCapture();
      }
    },
    [
      activeLotIdx,
      capturing,
      lots,
      mediaPermission?.granted,
      handleNextLot,
      setLots,
      onAutoSave,
      flash,
      maxResolutionMode,
      deviceWideMaxMP,
      resolutionPreset,
      getImageMetaAsync,
      saveToGallery,
      format,
      enhanceOn,
      queueAutoOptimizePhoto,
      currentZoom,
      device?.neutralZoom,
      computeNormalizedFocusBox,
      waitForDeviceSteady,
    ],
  );

  const startRecording = useCallback(async () => {
    if (isRecording) return;
    if (!cameraRef.current) return;

    if (!enableVideoUseCase) {
      setForceVideoUseCase(true);
      return;
    }

    const currentLot = lots[activeLotIdx];
    if (!currentLot?.mode) {
      Alert.alert(
        "Select Mode",
        "Capture at least one photo first to set the lot mode.",
      );
      return;
    }

    try {
      setIsRecording(true);
      setRecordingTime(0);

      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      // react-native-vision-camera video recording
      // 4K video recording for professional quality
      cameraRef.current.startRecording({
        flash: flash === "auto" ? "off" : flash, // Video only supports 'on' | 'off'
        onRecordingFinished: async (video: VisionVideoFile) => {
          const videoUri = `file://${video.path}`;

          if (videoUri) {
            const fileName = `lot-${activeLotIdx + 1}-video-${Date.now()}.mp4`;
            const newVideo: PhotoFile = {
              uri: videoUri,
              name: fileName,
              type: "video/mp4",
            };

            setLots((prev) => {
              const updated = [...prev];
              updated[activeLotIdx] = {
                ...updated[activeLotIdx],
                videoFile: newVideo,
              };
              return updated;
            });

            if (mediaPermission?.granted) {
              try {
                await MediaLibrary.saveToLibraryAsync(videoUri);
              } catch (e) {
                console.warn("Failed to save video:", e);
              }
            }
          }

          setIsRecording(false);
          setForceVideoUseCase(false);
          if (recordingIntervalRef.current) {
            clearInterval(recordingIntervalRef.current);
            recordingIntervalRef.current = null;
          }
        },
        onRecordingError: (error) => {
          console.error("Recording error:", error);
          setIsRecording(false);
          setForceVideoUseCase(false);
          if (recordingIntervalRef.current) {
            clearInterval(recordingIntervalRef.current);
            recordingIntervalRef.current = null;
          }
        },
      });
    } catch (e: any) {
      console.error("Recording start error:", e);
      setIsRecording(false);
      setForceVideoUseCase(false);
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
    }
  }, [
    activeLotIdx,
    enableVideoUseCase,
    flash,
    isRecording,
    lots,
    maxResolutionMode,
    mediaPermission?.granted,
    setLots,
  ]);

  useEffect(() => {
    if (!visible) return;
    if (!forceVideoUseCase) return;
    if (!enableVideoUseCase) return;
    if (isRecording) return;

    const t = setTimeout(() => {
      void startRecording();
    }, 350);

    return () => clearTimeout(t);
  }, [
    enableVideoUseCase,
    forceVideoUseCase,
    isRecording,
    startRecording,
    visible,
  ]);

  const stopRecording = useCallback(async () => {
    if (cameraRef.current && isRecording) {
      try {
        await cameraRef.current.stopRecording();
      } finally {
        setForceVideoUseCase(false);
      }
    }
  }, [isRecording]);

  const toggleFlash = useCallback(() => {
    setFlash((current) => (current === "off" ? "on" : "off")); // Simple on/off toggle for torch mode
  }, []);

  const currentLot = lots[activeLotIdx];
  const allPhotos: PhotoFile[] = currentLot
    ? [...currentLot.files, ...currentLot.extraFiles]
    : [];

  if (!visible) return null;

  // Permission screen
  if (!hasCameraPermission) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <SafeAreaView
          style={styles.permissionContainer}
          edges={["top", "bottom", "left", "right"]}
        >
          <Feather name="camera-off" size={64} color="#9CA3AF" />
          <Text style={styles.permissionTitle}>Camera Permission Required</Text>
          <Text style={styles.permissionText}>
            Please grant camera access to capture photos.
          </Text>
          <TouchableOpacity
            style={styles.permissionButton}
            onPress={requestCameraPermission}
          >
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.cancelButtonText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  // No camera device available - show loading state first, then error after timeout
  if (!device) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <SafeAreaView
          style={styles.permissionContainer}
          edges={["top", "bottom", "left", "right"]}
        >
          {cameraInitTimedOut ? (
            <>
              <Feather name="camera-off" size={64} color="#EF4444" />
              <Text style={styles.permissionTitle}>No Camera Found</Text>
              <Text style={styles.permissionText}>
                Unable to access camera device. Please try closing and reopening
                the camera.
              </Text>
              <TouchableOpacity
                style={[styles.permissionButton, { marginTop: 20 }]}
                onPress={() => {
                  // Reset and try again
                  setCameraInitAttempts(0);
                  setCameraInitTimedOut(false);
                }}
              >
                <Text style={styles.permissionButtonText}>Try Again</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                <Text style={styles.cancelButtonText}>Close</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.permissionTitle}>Initializing Camera...</Text>
              <Text style={styles.permissionText}>
                Please wait while we set up your camera.
                {cameraInitAttempts > 0 ? ` (${cameraInitAttempts}/10)` : ""}
              </Text>
              <TouchableOpacity
                style={[styles.cancelButton, { marginTop: 20 }]}
                onPress={onClose}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </SafeAreaView>
      </Modal>
    );
  }

  // Preview mode
  if (showPreview && allPhotos.length > 0) {
    return (
      <Modal
        key={`preview-${dimensions.width}x${dimensions.height}`}
        visible={visible}
        animationType="fade"
        presentationStyle="fullScreen"
        statusBarTranslucent
        supportedOrientations={["portrait", "landscape"]}
        onRequestClose={() => setShowPreview(false)}
      >
        <View
          style={[
            styles.previewContainer,
            {
              width: dimensions.width,
              height: dimensions.height,
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={styles.previewHeader}>
            <TouchableOpacity
              onPress={() => setShowPreview(false)}
              style={styles.previewBackBtn}
            >
              <Feather name="arrow-left" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.previewTitle}>
              Lot {activeLotIdx + 1} - {selectedPreviewIdx + 1}/
              {allPhotos.length}
            </Text>
            <View style={{ width: 40 }} />
          </View>

          <Image
            source={{
              uri:
                allPhotos[selectedPreviewIdx]?.displayUri ??
                allPhotos[selectedPreviewIdx]?.uri,
            }}
            style={styles.previewImage}
            resizeMode="contain"
          />

          <ScrollView
            horizontal
            style={styles.previewThumbnails}
            contentContainerStyle={styles.thumbnailsContent}
            showsHorizontalScrollIndicator={false}
          >
            {allPhotos.map((item, index) => (
              <TouchableOpacity
                key={`thumb-${index}`}
                onPress={() => setSelectedPreviewIdx(index)}
                style={[
                  styles.thumbnail,
                  index === selectedPreviewIdx && styles.thumbnailActive,
                ]}
              >
                <Image
                  source={{ uri: item.displayUri ?? item.uri }}
                  style={styles.thumbnailImage}
                />
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View
            style={[
              styles.previewActions,
              { paddingBottom: Math.max(insets.bottom, 16) },
            ]}
          >
            <TouchableOpacity
              style={styles.continueBtn}
              onPress={() => setShowPreview(false)}
            >
              <Feather name="camera" size={20} color="#fff" />
              <Text style={styles.continueBtnText}>Back to Camera</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  // Main camera view - Portrait
  if (!isLandscape) {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        onRequestClose={onClose}
        supportedOrientations={["portrait", "landscape"]}
      >
        <View style={styles.container}>
          <GestureDetector gesture={cameraGestures}>
            <Reanimated.View
              ref={cameraWrapperRef}
              style={[styles.cameraWrapper, styles.cameraWrapperPortrait43]}
              onLayout={handleCameraWrapperLayout}
              onTouchEnd={
                Platform.OS === "android" ? handleCameraTouchEnd : undefined
              }
            >
              <ReanimatedCamera
                key={`${cameraSessionKey}-${enableVideoUseCase ? "video" : "photo"}`}
                ref={cameraRef}
                style={[
                  styles.cameraPortrait43,
                  {
                    width: portraitPreviewRect.width,
                    height: portraitPreviewRect.height,
                  },
                ]}
                device={device}
                isActive={isCameraActive && visible}
                onInitialized={handleCameraInitialized}
                photo={true}
                video={enableVideoUseCase}
                audio={enableVideoUseCase && hasMicPermission}
                enableZoomGesture={false}
                exposure={exposure}
                format={format}
                focusable={true}
                animatedProps={cameraAnimatedProps}
                enableBufferCompression={enableBufferCompression}
                photoQualityBalance={photoQualityBalance}
                photoHdr={enableHdr && format?.supportsPhotoHdr}
                videoHdr={
                  enableVideoUseCase && enableHdr && format?.supportsVideoHdr
                }
                videoBitRate={videoBitRate}
                torch={flash === "on" ? "on" : "off"}
                lowLightBoost={lowLightBoost && device?.supportsLowLightBoost}
                enableDepthData={
                  portraitMode && selectedFormat?.supportsDepthCapture
                }
              />
              <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                <FocusBox
                  visible={focusOn}
                  isLandscape={false}
                  viewWidth={cameraViewDimensions.width || dimensions.width}
                  viewHeight={cameraViewDimensions.height || dimensions.height}
                  onBoxChange={setFocusBoxRect}
                />
                <RecordingIndicator
                  isRecording={isRecording}
                  recordingTime={recordingTime}
                />

                {allPhotos.length > 0 && (
                  <View
                    pointerEvents="box-none"
                    style={[
                      styles.thumbnailOverlayPortrait,
                      {
                        left: Math.max(insets.left, 8),
                        bottom: portraitBottomBarHeight + 12,
                      },
                    ]}
                  >
                    <PhotoThumbnails
                      photos={allPhotos}
                      onPress={() => setShowPreview(true)}
                      compact
                    />
                  </View>
                )}

                {/* Tap-to-Focus Indicator */}
                {tapFocusPoint && (
                  <Animated.View
                    style={[
                      styles.tapFocusIndicator,
                      {
                        left: tapFocusPoint.x - 40,
                        top: tapFocusPoint.y - 40,
                        opacity: tapFocusAnim,
                        transform: [{ scale: tapFocusAnim }],
                      },
                    ]}
                  />
                )}

                {/* Top Controls */}
                <View
                  style={[styles.topBar, { paddingTop: insets.top + 4 }]}
                  onLayout={(e) =>
                    setPortraitTopBarHeight(e.nativeEvent.layout.height)
                  }
                >
                  <DoneButton onDone={onClose} compact />
                  <LotNavigation
                    lots={lots}
                    activeLotIdx={activeLotIdx}
                    onPrevLot={handlePrevLot}
                    onNextLot={handleNextLot}
                    compact
                  />
                  <TopControls
                    flash={flash}
                    focusOn={focusOn}
                    onFlashToggle={toggleFlash}
                    onFocusToggle={() => setFocusOn(!focusOn)}
                    onDone={onClose}
                    compact
                  />
                </View>

                {/* Bottom Controls - Compact stacked layout */}
                <View
                  style={[
                    styles.bottomBar,
                    { paddingBottom: insets.bottom + 6 },
                  ]}
                  onLayout={(e) =>
                    setPortraitBottomBarHeight(e.nativeEvent.layout.height)
                  }
                >
                  {/* Row 0: Close button, Zoom Sensors, and Mode buttons */}
                  <View style={styles.bottomBarTopRow}>
                    <TouchableOpacity
                      onPress={onClose}
                      style={styles.closeBtnPortrait}
                    >
                      <Feather name="x" size={18} color="#fff" />
                    </TouchableOpacity>
                    <View style={styles.zoomPresetsInline}>
                      {zoomPresets.map((preset) => {
                        const isActive =
                          Math.abs(currentZoom - preset.value) < 0.1;
                        return (
                          <TouchableOpacity
                            key={preset.label}
                            style={[
                              styles.zoomPresetBtnSmall,
                              isActive && styles.zoomPresetBtnActiveSmall,
                            ]}
                            onPress={() => handleZoomPresetPress(preset)}
                          >
                            <Text
                              style={[
                                styles.zoomPresetTextSmall,
                                isActive && styles.zoomPresetTextActiveSmall,
                              ]}
                            >
                              {preset.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {/* Camera Mode Buttons - Low Light & Portrait */}
                    <View style={styles.cameraModeButtons}>
                      {device?.supportsLowLightBoost && (
                        <TouchableOpacity
                          style={[
                            styles.cameraModeBtn,
                            lowLightBoost && styles.cameraModeBtnActive,
                          ]}
                          onPress={toggleLowLightBoost}
                        >
                          <Feather
                            name="moon"
                            size={14}
                            color={lowLightBoost ? "#FCD34D" : "#fff"}
                          />
                        </TouchableOpacity>
                      )}
                      {selectedFormat?.supportsDepthCapture && (
                        <TouchableOpacity
                          style={[
                            styles.cameraModeBtn,
                            portraitMode && styles.cameraModeBtnActive,
                          ]}
                          onPress={togglePortraitMode}
                        >
                          <Feather
                            name="user"
                            size={14}
                            color={portraitMode ? "#60A5FA" : "#fff"}
                          />
                        </TouchableOpacity>
                      )}
                      {canUseMacro && (
                        <TouchableOpacity
                          style={[
                            styles.cameraModeBtn,
                            macroMode && styles.cameraModeBtnActive,
                          ]}
                          onPress={toggleMacroMode}
                        >
                          <Feather
                            name="aperture"
                            size={14}
                            color={macroMode ? "#34D399" : "#fff"}
                          />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                  <View style={styles.performanceRowPortrait}>
                    <View style={styles.performanceButtonsPortrait}>
                      {(
                        [
                          { key: "speed", label: "Speed" },
                          { key: "balanced", label: "Balanced" },
                          { key: "quality", label: "Quality" },
                        ] as Array<{
                          key: CameraPerformanceMode;
                          label: string;
                        }>
                      ).map((item) => {
                        const active = performanceMode === item.key;
                        return (
                          <TouchableOpacity
                            key={item.key}
                            style={[
                              styles.performanceBtn,
                              active && styles.performanceBtnActive,
                            ]}
                            onPress={() => setPerformance(item.key)}
                            disabled={isRecording || capturing}
                          >
                            <Text
                              style={[
                                styles.performanceBtnText,
                                active && styles.performanceBtnTextActive,
                              ]}
                            >
                              {item.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <RecordButton
                      isRecording={isRecording}
                      onStartRecording={startRecording}
                      onStopRecording={stopRecording}
                      disabled={!currentLot?.mode}
                      compact
                    />
                  </View>
                  {/* Row 1: Capture buttons */}
                  <View style={styles.bottomBarRow}>
                    <CaptureButtons
                      onCapture={handleCapture}
                      disabled={capturing}
                    />
                  </View>
                </View>

                {capturing && (
                  <View style={styles.capturingOverlay}>
                    <ActivityIndicator color="#fff" size="large" />
                  </View>
                )}
              </View>
            </Reanimated.View>
          </GestureDetector>
        </View>
      </Modal>
    );
  }

  const getModeLabel = (mode?: string) => {
    if (!mode) return "—";
    return mode === "single_lot"
      ? "Bundle"
      : mode === "per_item"
        ? "Per Item"
        : "Per Photo";
  };

  // Main camera view - Landscape (controls on right side like web MixedSection)
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.container}>
        <GestureDetector gesture={cameraGestures}>
          <Reanimated.View
            ref={cameraWrapperRef}
            style={styles.cameraWrapper}
            onLayout={handleCameraWrapperLayout}
            onTouchEnd={
              Platform.OS === "android" ? handleCameraTouchEnd : undefined
            }
          >
            <ReanimatedCamera
              key={`${cameraSessionKey}-${enableVideoUseCase ? "video" : "photo"}`}
              ref={cameraRef}
              style={styles.camera}
              device={device}
              isActive={isCameraActive && visible}
              onInitialized={handleCameraInitialized}
              photo={true}
              video={enableVideoUseCase}
              audio={enableVideoUseCase && hasMicPermission}
              enableZoomGesture={false}
              exposure={exposure}
              format={format}
              focusable={true}
              animatedProps={cameraAnimatedProps}
              enableBufferCompression={enableBufferCompression}
              photoQualityBalance={photoQualityBalance}
              photoHdr={enableHdr && format?.supportsPhotoHdr}
              videoHdr={
                enableVideoUseCase && enableHdr && format?.supportsVideoHdr
              }
              videoBitRate={videoBitRate}
              torch={flash === "on" ? "on" : "off"}
              lowLightBoost={lowLightBoost && device?.supportsLowLightBoost}
              enableDepthData={
                portraitMode && selectedFormat?.supportsDepthCapture
              }
            />

            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              <FocusBox
                visible={focusOn}
                isLandscape={true}
                viewWidth={cameraViewDimensions.width || dimensions.width}
                viewHeight={cameraViewDimensions.height || dimensions.height}
                onBoxChange={setFocusBoxRect}
              />
              <RecordingIndicator
                isRecording={isRecording}
                recordingTime={recordingTime}
              />

              {/* Tap-to-Focus Indicator */}
              {tapFocusPoint && (
                <Animated.View
                  style={[
                    styles.tapFocusIndicator,
                    {
                      left: tapFocusPoint.x - 40,
                      top: tapFocusPoint.y - 40,
                      opacity: tapFocusAnim,
                      transform: [{ scale: tapFocusAnim }],
                    },
                  ]}
                />
              )}

              {/* Top Bar in Landscape - Compact like web */}
              <View
                style={[
                  styles.topBarLandscape,
                  {
                    paddingTop: Math.max(insets.top, 4),
                    paddingLeft: Math.max(insets.left, 8),
                    paddingRight: Math.max(insets.right, 4) + 95,
                  },
                ]}
                onLayout={(e) =>
                  setLandscapeTopBarHeight(e.nativeEvent.layout.height)
                }
              >
                {/* Exit Button */}
                <TouchableOpacity
                  onPress={onClose}
                  style={styles.exitBtnLandscape}
                >
                  <Feather name="x" size={16} color="#fff" />
                  <Text style={styles.exitBtnText}>Exit</Text>
                </TouchableOpacity>

                {/* Center Info - Compact */}
                <View style={styles.landscapeCenterInfo}>
                  {/* Prev/Next Lot Navigation */}
                  <View style={styles.landscapeCenterInfoRow}>
                    <Text style={styles.landscapeInfoText} numberOfLines={1}>
                      Lot {activeLotIdx + 1} | {currentLot?.files.length ?? 0}{" "}
                      main | {currentLot?.extraFiles.length ?? 0} extra |{" "}
                      {getModeLabel(currentLot?.mode)}
                      {isRecording && " | REC"}
                    </Text>
                  </View>
                </View>

                {/* Right Controls - Flash, Focus, Image Thumbnails */}
                <View style={styles.landscapeTopControls}>
                  <TouchableOpacity
                    onPress={toggleFlash}
                    style={styles.topControlBtn}
                  >
                    <Feather
                      name={flash === "off" ? "zap-off" : "zap"}
                      size={14}
                      color={flash === "on" ? "#FCD34D" : "#fff"}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setFocusOn(!focusOn)}
                    style={[
                      styles.topControlBtn,
                      focusOn && styles.topControlBtnActive,
                    ]}
                  >
                    <Feather name="crosshair" size={14} color="#fff" />
                  </TouchableOpacity>
                  {/* Image Thumbnails in Landscape - Stacked Preview */}
                  <View style={styles.landscapeThumbnailWrapper}>
                    <PhotoThumbnails
                      photos={allPhotos}
                      onPress={() => setShowPreview(true)}
                      isLandscape={true}
                    />
                  </View>
                </View>
              </View>

              {/* Right Side Controls Panel - Full height from top to bottom */}
              <View
                style={[
                  styles.rightPanel,
                  {
                    right: Math.max(insets.right, 2),
                    top: 0,
                    bottom: 0,
                    paddingTop: Math.max(insets.top, 2),
                    paddingBottom: Math.max(insets.bottom, 2),
                  },
                ]}
                onLayout={(e) => {
                  setLandscapeRightPanelWidth(e.nativeEvent.layout.width);
                  setLandscapeRightPanelHeight(e.nativeEvent.layout.height);
                }}
              >
                <View style={styles.rightPanelContent}>
                  <View
                    style={[
                      styles.rightPanelTopGroup,
                      isLandscapeRightPanelTight &&
                        styles.rightPanelTopGroupTight,
                    ]}
                  >
                    {/* Capture Buttons - Bundle Row */}
                    <View
                      style={[
                        styles.captureRowLandscape,
                        isLandscapeRightPanelTight &&
                          styles.captureRowLandscapeTight,
                      ]}
                    >
                      <TouchableOpacity
                        style={[
                          styles.captureBtnMainLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnMainLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("single_lot", false)}
                        disabled={capturing}
                      >
                        <Feather name="camera" size={12} color="#fff" />
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Bundle
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.captureBtnExtraLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnExtraLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("single_lot", true)}
                        disabled={capturing}
                      >
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Extra
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Capture Buttons - Item Row */}
                    <View
                      style={[
                        styles.captureRowLandscape,
                        isLandscapeRightPanelTight &&
                          styles.captureRowLandscapeTight,
                      ]}
                    >
                      <TouchableOpacity
                        style={[
                          styles.captureBtnMainLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnMainLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("per_item", false)}
                        disabled={capturing}
                      >
                        <Feather name="camera" size={12} color="#fff" />
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Item
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.captureBtnExtraLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnExtraLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("per_item", true)}
                        disabled={capturing}
                      >
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Extra
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Capture Buttons - Photo Row */}
                    <View
                      style={[
                        styles.captureRowLandscape,
                        isLandscapeRightPanelTight &&
                          styles.captureRowLandscapeTight,
                      ]}
                    >
                      <TouchableOpacity
                        style={[
                          styles.captureBtnMainLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnMainLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("per_photo", false)}
                        disabled={capturing}
                      >
                        <Feather name="camera" size={12} color="#fff" />
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Photo
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.captureBtnExtraLandscape,
                          isLandscapeRightPanelTight &&
                            styles.captureBtnExtraLandscapeTight,
                          { height: landscapeRightPanelControlHeights.capture },
                        ]}
                        onPress={() => handleCapture("per_photo", true)}
                        disabled={capturing}
                      >
                        <Text
                          style={styles.captureBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Extra
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Record Button */}
                    <View
                      style={[
                        styles.recordBlockLandscape,
                        isLandscapeRightPanelTight &&
                          styles.recordBlockLandscapeTight,
                      ]}
                    >
                      <TouchableOpacity
                        style={[
                          styles.recordBtnLandscape,
                          isRecording && styles.recordBtnActiveLandscape,
                          !currentLot?.mode &&
                            styles.recordBtnDisabledLandscape,
                          isLandscapeRightPanelTight &&
                            styles.recordBtnLandscapeTight,
                          { height: landscapeRightPanelControlHeights.record },
                        ]}
                        onPress={isRecording ? stopRecording : startRecording}
                        disabled={!currentLot?.mode}
                      >
                        <Text
                          style={styles.recordBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          {isRecording ? "Stop" : "Record"}
                        </Text>
                      </TouchableOpacity>

                      {(device?.supportsLowLightBoost || canUseMacro) && (
                        <View
                          style={[
                            styles.recordExtrasLandscapeRow,
                            isLandscapeRightPanelTight &&
                              styles.recordExtrasLandscapeRowTight,
                          ]}
                        >
                          {device?.supportsLowLightBoost && (
                            <TouchableOpacity
                              style={[
                                styles.recordExtraBtnLandscape,
                                lowLightBoost &&
                                  styles.recordExtraBtnLandscapeActive,
                                isLandscapeRightPanelTight &&
                                  styles.recordExtraBtnLandscapeTight,
                                {
                                  height:
                                    landscapeRightPanelControlHeights.extra,
                                },
                              ]}
                              onPress={toggleLowLightBoost}
                            >
                              <Feather
                                name="moon"
                                size={10}
                                color={lowLightBoost ? "#FCD34D" : "#fff"}
                              />
                              <Text
                                style={[
                                  styles.recordExtraBtnTextLandscape,
                                  lowLightBoost &&
                                    styles.recordExtraBtnTextLandscapeActive,
                                ]}
                                numberOfLines={1}
                                adjustsFontSizeToFit
                                allowFontScaling={false}
                              >
                                Night
                              </Text>
                            </TouchableOpacity>
                          )}

                          {canUseMacro && (
                            <TouchableOpacity
                              style={[
                                styles.recordExtraBtnLandscape,
                                macroMode &&
                                  styles.recordExtraBtnLandscapeActive,
                                isLandscapeRightPanelTight &&
                                  styles.recordExtraBtnLandscapeTight,
                                {
                                  height:
                                    landscapeRightPanelControlHeights.extra,
                                },
                              ]}
                              onPress={toggleMacroMode}
                            >
                              <Feather
                                name="aperture"
                                size={10}
                                color={macroMode ? "#34D399" : "#fff"}
                              />
                              <Text
                                style={[
                                  styles.recordExtraBtnTextLandscape,
                                  macroMode &&
                                    styles.recordExtraBtnTextLandscapeActive,
                                ]}
                                numberOfLines={1}
                                adjustsFontSizeToFit
                                allowFontScaling={false}
                              >
                                Macro
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                    </View>

                    {/* Zoom Presets - Landscape (all sensors) */}
                    <View
                      style={[
                        styles.zoomPresetsLandscape,
                        isLandscapeRightPanelTight &&
                          styles.zoomPresetsLandscapeTight,
                      ]}
                    >
                      {zoomPresets.map((preset) => {
                        const isActive =
                          Math.abs(currentZoom - preset.value) < 0.1;
                        return (
                          <TouchableOpacity
                            key={preset.label}
                            style={[
                              styles.zoomPresetBtnLandscape,
                              isLandscapeRightPanelTight &&
                                styles.zoomPresetBtnLandscapeTight,
                              isActive && styles.zoomPresetBtnActiveLandscape,
                              {
                                height: landscapeRightPanelControlHeights.zoom,
                              },
                            ]}
                            onPress={() => handleZoomPresetPress(preset)}
                          >
                            <Text
                              style={[
                                styles.zoomPresetTextLandscape,
                                isActive &&
                                  styles.zoomPresetTextActiveLandscape,
                              ]}
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              allowFontScaling={false}
                            >
                              {preset.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View
                      style={[
                        styles.performanceRowLandscape,
                        isLandscapeRightPanelTight &&
                          styles.performanceRowLandscapeTight,
                      ]}
                    >
                      {(
                        [
                          { key: "speed", label: "Speed" },
                          { key: "balanced", label: "Balanced" },
                          { key: "quality", label: "Quality" },
                        ] as Array<{
                          key: CameraPerformanceMode;
                          label: string;
                        }>
                      ).map((item) => {
                        const active = performanceMode === item.key;
                        return (
                          <TouchableOpacity
                            key={item.key}
                            style={[
                              styles.performanceBtnLandscape,
                              isLandscapeRightPanelTight &&
                                styles.performanceBtnLandscapeTight,
                              active && styles.performanceBtnLandscapeActive,
                              {
                                height:
                                  landscapeRightPanelControlHeights.performance,
                              },
                            ]}
                            onPress={() => setPerformance(item.key)}
                            disabled={isRecording || capturing}
                          >
                            <Text
                              style={[
                                styles.performanceBtnTextLandscape,
                                active &&
                                  styles.performanceBtnTextLandscapeActive,
                              ]}
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              allowFontScaling={false}
                            >
                              {item.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* Camera Mode Buttons - Low Light & Portrait (Landscape) */}
                    <View
                      style={[
                        styles.cameraModeBtnLandscapeRow,
                        isLandscapeRightPanelTight &&
                          styles.cameraModeBtnLandscapeRowTight,
                      ]}
                    >
                      {selectedFormat?.supportsDepthCapture && (
                        <TouchableOpacity
                          style={[
                            styles.cameraModeBtnLandscape,
                            isLandscapeRightPanelTight &&
                              styles.cameraModeBtnLandscapeTight,
                            portraitMode && styles.cameraModeBtnLandscapeActive,
                            {
                              height:
                                landscapeRightPanelControlHeights.cameraMode,
                            },
                          ]}
                          onPress={togglePortraitMode}
                        >
                          <Feather
                            name="user"
                            size={12}
                            color={portraitMode ? "#60A5FA" : "#fff"}
                          />
                          <Text
                            style={[
                              styles.cameraModeBtnTextLandscape,
                              portraitMode &&
                                styles.cameraModeBtnTextLandscapeActive,
                            ]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            allowFontScaling={false}
                          >
                            Portrait
                          </Text>
                        </TouchableOpacity>
                      )}

                      <TouchableOpacity
                        onPress={handlePrevLot}
                        disabled={activeLotIdx <= 0}
                        style={[
                          styles.cameraModeBtnLandscape,
                          isLandscapeRightPanelTight &&
                            styles.cameraModeBtnLandscapeTight,
                          activeLotIdx <= 0 && styles.lotNavBtnDisabled,
                          {
                            height:
                              landscapeRightPanelControlHeights.cameraMode,
                          },
                        ]}
                      >
                        <Feather name="chevron-left" size={12} color="#fff" />
                        <Text
                          style={styles.cameraModeBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Prev
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={handleNextLot}
                        style={[
                          styles.cameraModeBtnLandscape,
                          isLandscapeRightPanelTight &&
                            styles.cameraModeBtnLandscapeTight,
                          {
                            height:
                              landscapeRightPanelControlHeights.cameraMode,
                          },
                        ]}
                      >
                        <Feather name="chevron-right" size={12} color="#fff" />
                        <Text
                          style={styles.cameraModeBtnTextLandscape}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          allowFontScaling={false}
                        >
                          Next
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Done Button - Full Width */}
                  <TouchableOpacity
                    style={[
                      styles.doneBtnLandscapeFull,
                      isLandscapeRightPanelTight &&
                        styles.doneBtnLandscapeFullTight,
                      { height: landscapeRightPanelControlHeights.done },
                    ]}
                    onPress={onClose}
                  >
                    <Feather name="check" size={12} color="#fff" />
                    <Text
                      style={styles.doneBtnTextLandscapeFull}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      allowFontScaling={false}
                    >
                      Done
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {capturing && (
                <View style={styles.capturingOverlay}>
                  <ActivityIndicator color="#fff" size="large" />
                </View>
              )}
            </View>
          </Reanimated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  cameraWrapper: {
    flex: 1,
  },
  cameraWrapperPortrait43: {
    justifyContent: "center",
    alignItems: "center",
  },
  camera: {
    flex: 1,
  },
  cameraPortrait43: {
    width: "100%",
    aspectRatio: 3 / 4,
  },
  debugOverlay: {
    position: "absolute",
    left: 10,
    right: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  debugText: {
    color: "#fff",
    fontSize: 12,
    lineHeight: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  resolutionModal: {
    backgroundColor: "#fff",
    borderRadius: 18,
    paddingBottom: 14,
    overflow: "hidden",
  },
  resolutionButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  resolutionBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#F3F4F6",
  },
  resolutionBtnActive: {
    backgroundColor: "#111827",
  },
  resolutionBtnText: {
    color: "#111827",
    fontWeight: "700",
    fontSize: 14,
  },
  resolutionBtnTextActive: {
    color: "#fff",
  },
  resolutionInfo: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  resolutionInfoText: {
    color: "#111827",
    fontWeight: "700",
  },
  resolutionInfoSubText: {
    color: "#6B7280",
    marginTop: 4,
  },
  filterModal: {
    backgroundColor: "#fff",
    borderRadius: 18,
    overflow: "hidden",
  },
  filterPreview: {
    width: "100%",
    height: 240,
    backgroundColor: "#000",
  },
  filterPreviewEmpty: {
    width: "100%",
    height: 240,
    backgroundColor: "#111827",
    justifyContent: "center",
    alignItems: "center",
  },
  filterPreviewEmptyText: {
    color: "#fff",
    fontWeight: "700",
  },
  filterControls: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    maxHeight: 280,
  },
  filterEnableRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#F9FAFB",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  filterEnableLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  filterEnableText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
  },
  filterSliderSection: {
    marginBottom: 16,
  },
  nativeSlider: {
    width: "100%",
    height: 40,
  },
  filterHint: {
    textAlign: "center",
    fontSize: 11,
    color: "#9CA3AF",
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  filterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  filterLabel: {
    color: "#111827",
    fontWeight: "700",
  },
  filterValue: {
    color: "#6B7280",
    fontWeight: "700",
  },
  sliderTrack: {
    height: 20,
    borderRadius: 10,
    backgroundColor: "#E5E7EB",
    overflow: "hidden",
    justifyContent: "center",
  },
  sliderFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#111827",
  },
  sliderKnob: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#FCD34D",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.15)",
  },
  filterActions: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  filterBtnSecondary: {
    flex: 1,
    backgroundColor: "#F3F4F6",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  filterBtnSecondaryText: {
    color: "#111827",
    fontWeight: "800",
  },
  filterBtnPrimary: {
    flex: 1,
    backgroundColor: "#111827",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  filterBtnPrimaryText: {
    color: "#fff",
    fontWeight: "800",
  },
  // Tap-to-focus indicator
  tapFocusIndicator: {
    position: "absolute",
    width: 80,
    height: 80,
    borderWidth: 3,
    borderColor: "#FBBF24",
    borderRadius: 8,
    backgroundColor: "rgba(251, 191, 36, 0.1)",
  },
  thumbnailOverlayPortrait: {
    position: "absolute",
    zIndex: 30,
    elevation: 10,
  },
  // Portrait Top Bar
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingBottom: 4,
  },
  // Portrait Bottom Bar - Compact stacked layout
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: "column",
    gap: 4,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  bottomBarTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.1)",
  },
  performanceRowPortrait: {
    flexDirection: "row",
    gap: 6,
    paddingVertical: 4,
    justifyContent: "space-between",
    alignItems: "center",
  },
  performanceButtonsPortrait: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    alignItems: "center",
  },
  performanceBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
  },
  performanceBtnActive: {
    backgroundColor: "#FCD34D",
    borderColor: "#FCD34D",
  },
  performanceBtnText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 11,
    fontWeight: "800",
  },
  performanceBtnTextActive: {
    color: "#000",
  },
  closeBtnPortrait: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  zoomPresetsInline: {
    flexDirection: "row",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    borderRadius: 16,
    padding: 2,
    gap: 2,
  },
  zoomPresetBtnSmall: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "transparent",
    minWidth: 36,
    alignItems: "center",
  },
  zoomPresetBtnActiveSmall: {
    backgroundColor: "#FCD34D",
  },
  zoomPresetTextSmall: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 12,
    fontWeight: "700",
  },
  zoomPresetTextActiveSmall: {
    color: "#000",
  },
  bottomBarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 2,
  },
  bottomBarControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 0,
  },
  // Lens Selector (0.5x, 1x, 2x)
  lensSelector: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
    gap: 8,
  },
  lensBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
  lensBtnActive: {
    backgroundColor: "rgba(255,255,255,0.95)",
    borderColor: "#FCD34D",
  },
  lensBtnText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 13,
    fontWeight: "bold",
  },
  lensBtnTextActive: {
    color: "#000",
  },
  lensSelectorLandscape: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 3,
    marginBottom: 4,
  },
  lensBtnLandscape: {
    width: 28,
    height: 28,
    minWidth: 24,
    minHeight: 24,
    maxWidth: 32,
    maxHeight: 32,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  // Landscape Top Bar - Transparent with floating buttons
  topBarLandscape: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "transparent",
  },
  exitBtnLandscape: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  exitBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "500",
  },
  landscapeCenterInfo: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 8,
  },
  landscapeCenterInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  landscapeInfoText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: "hidden",
  },
  lotNavIconBtnTop: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 8,
  },
  lotNavIconBtnTopDisabled: {
    opacity: 0.35,
  },
  landscapeTopControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  topControlBtn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 8,
    borderRadius: 8,
  },
  topControlBtnActive: {
    backgroundColor: "rgba(239, 68, 68, 0.8)",
  },
  topControlBtnText: {
    color: "#fff",
    fontSize: 11,
  },
  // Landscape Thumbnail Wrapper - Add spacing and positioning
  landscapeThumbnailWrapper: {
    marginLeft: 16,
    paddingLeft: 12,
  },
  // Landscape Thumbnail Button - Compact Icon with Count
  landscapeThumbnailButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(37, 99, 235, 0.9)",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    marginLeft: 8,
  },
  landscapeThumbnailButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  // Legacy styles (kept for compatibility)
  landscapeTopInfo: {
    flex: 1,
    alignItems: "center",
  },
  lotBadgeLandscape: {
    backgroundColor: "rgba(37, 99, 235, 0.9)",
    color: "#fff",
    fontSize: 13,
    fontWeight: "bold",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: "hidden",
  },
  statsTextLandscape: {
    color: "#fff",
    fontSize: 10,
    marginTop: 2,
  },
  controlBtnSmall: {
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: 10,
  },
  controlBtnActiveSmall: {
    backgroundColor: "rgba(239, 68, 68, 0.7)",
  },
  // Right Panel (Landscape) - Full height from top to bottom
  rightPanel: {
    position: "absolute",
    width: 115,
    paddingHorizontal: 6,
    paddingTop: 0,
    paddingBottom: 0,
    justifyContent: "flex-start",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
  rightPanelScroll: {
    flex: 1,
  },
  rightPanelContent: {
    flex: 1,
    justifyContent: "space-between",
  },
  rightPanelTopGroup: {
    flexShrink: 1,
    gap: 3,
    minHeight: 0,
  },
  rightPanelTopGroupTight: {
    gap: 2,
  },
  // Lens styles for landscape
  lensBtnActiveLandscape: {
    backgroundColor: "#EAB308",
  },
  lensBtnTextLandscape: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
  },
  lensBtnTextActiveLandscape: {
    color: "#000",
  },
  // Legacy zoom styles (kept for landscape compatibility)
  zoomPresets: {
    flexDirection: "row",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderRadius: 20,
    padding: 2,
    gap: 2,
  },
  zoomPresetBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "transparent",
    minWidth: 38,
    alignItems: "center",
  },
  zoomPresetBtnActive: {
    backgroundColor: "#FCD34D",
  },
  zoomPresetText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 12,
    fontWeight: "700",
  },
  zoomPresetTextActive: {
    color: "#000",
  },
  // Camera Mode Buttons (Low Light, Portrait)
  cameraModeButtons: {
    flexDirection: "row",
    gap: 6,
    marginLeft: 8,
  },
  cameraModeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
  },
  cameraModeBtnActive: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderColor: "rgba(255, 255, 255, 0.5)",
  },
  // Camera Mode Buttons - Landscape
  cameraModeBtnLandscapeRow: {
    flexDirection: "row",
    gap: 2,
  },
  cameraModeBtnLandscapeRowTight: {
    gap: 1,
  },
  cameraModeBtnLandscape: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
  },
  cameraModeBtnLandscapeTight: {
    paddingVertical: 1,
  },
  cameraModeBtnLandscapeActive: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderColor: "rgba(255, 255, 255, 0.5)",
  },
  cameraModeBtnTextLandscape: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "600",
  },
  cameraModeBtnTextLandscapeActive: {
    color: "#FCD34D",
  },
  zoomSliderContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 12,
    width: "100%",
    maxWidth: 320,
  },
  zoomLabel: {
    color: "#FCD34D",
    fontSize: 14,
    fontWeight: "700",
    minWidth: 42,
    textAlign: "center",
  },
  zoomSliderTrack: {
    flex: 1,
    height: 32,
    justifyContent: "center",
  },
  zoomSliderTrackTouchable: {
    width: "100%",
    height: 32,
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 4,
  },
  zoomSliderFill: {
    position: "absolute",
    left: 0,
    height: "100%",
    backgroundColor: "rgba(252, 211, 77, 0.4)",
    borderRadius: 4,
  },
  zoomSliderThumb: {
    position: "absolute",
    width: 20,
    height: 28,
    borderRadius: 4,
    backgroundColor: "#FCD34D",
    marginLeft: -10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  // Zoom Controls - Landscape (compact row)
  zoomPresetsLandscape: {
    flexDirection: "row",
    gap: 2,
    marginVertical: 1,
  },
  zoomPresetsLandscapeTight: {
    gap: 1,
    marginVertical: 0,
  },
  zoomPresetBtnLandscape: {
    flex: 1,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.25)",
  },
  zoomPresetBtnLandscapeTight: {
    height: 16,
  },
  zoomPresetBtnActiveLandscape: {
    backgroundColor: "#FCD34D",
    borderColor: "#FCD34D",
  },
  zoomPresetTextLandscape: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
  },
  zoomPresetTextActiveLandscape: {
    color: "#000",
  },
  performanceRowLandscape: {
    flexDirection: "row",
    gap: 2,
  },
  performanceRowLandscapeTight: {
    gap: 1,
  },
  performanceBtnLandscape: {
    flex: 1,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.25)",
  },
  performanceBtnLandscapeTight: {
    height: 16,
  },
  performanceBtnLandscapeActive: {
    backgroundColor: "#FCD34D",
    borderColor: "#FCD34D",
  },
  performanceBtnTextLandscape: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "800",
  },
  performanceBtnTextLandscapeActive: {
    color: "#000",
  },
  // Capture buttons landscape - Taller buttons for full height panel
  captureRowLandscape: {
    flexDirection: "row",
    gap: 2,
  },
  captureRowLandscapeTight: {
    gap: 1,
  },
  captureBtnMainLandscape: {
    flex: 1,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244, 63, 94, 0.9)",
    borderRadius: 6,
    gap: 2,
    paddingHorizontal: 3,
  },
  captureBtnMainLandscapeTight: {
    height: 24,
    gap: 1,
    paddingHorizontal: 2,
  },
  captureBtnExtraLandscape: {
    flex: 1,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(59, 130, 246, 0.9)",
    borderRadius: 6,
  },
  captureBtnExtraLandscapeTight: {
    height: 24,
  },
  captureBtnTextLandscape: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
  },
  // Record button landscape - Taller
  recordBlockLandscape: {
    gap: 2,
  },
  recordBlockLandscapeTight: {
    gap: 1,
  },
  recordBtnLandscape: {
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(234, 179, 8, 0.9)",
    borderRadius: 6,
  },
  recordBtnLandscapeTight: {
    height: 16,
  },
  recordBtnActiveLandscape: {
    backgroundColor: "rgba(239, 68, 68, 0.95)",
  },
  recordBtnDisabledLandscape: {
    opacity: 0.4,
  },
  recordBtnTextLandscape: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
  },
  recordExtrasLandscapeRow: {
    flexDirection: "row",
    gap: 2,
  },
  recordExtrasLandscapeRowTight: {
    gap: 1,
  },
  recordExtraBtnLandscape: {
    flex: 1,
    height: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.25)",
  },
  recordExtraBtnLandscapeTight: {
    height: 12,
    gap: 1,
  },
  recordExtraBtnLandscapeActive: {
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    borderColor: "rgba(255, 255, 255, 0.35)",
  },
  recordExtraBtnTextLandscape: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "700",
  },
  recordExtraBtnTextLandscapeActive: {
    color: "#fff",
  },
  lotNavBtnDisabled: {
    opacity: 0.35,
  },
  // Action row landscape (settings + enhance) - Taller
  actionRowLandscape: {
    flexDirection: "row",
    gap: 6,
    marginTop: 4,
  },
  settingsBtnLandscape: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  enhanceBtnLandscape: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  enhanceBtnLandscapeActive: {
    backgroundColor: "rgba(252, 211, 77, 0.35)",
  },
  // Done button landscape (inline - kept for compatibility)
  doneBtnLandscape: {
    flex: 1,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(34, 197, 94, 0.85)",
    borderRadius: 8,
    gap: 4,
  },
  doneBtnTextLandscape: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  // Done button landscape - FULL WIDTH taller
  doneBtnLandscapeFull: {
    width: "100%",
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#22C55E",
    borderRadius: 8,
    gap: 4,
    marginTop: 2,
  },
  doneBtnLandscapeFullTight: {
    height: 26,
    marginTop: 1,
  },
  doneBtnTextLandscapeFull: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "bold",
  },
  // Thumbnail button inline for landscape
  thumbBtnLandscape: {
    flex: 1,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(37, 99, 235, 0.8)",
    borderRadius: 8,
  },
  thumbCountInline: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "bold",
  },
  lotNavLandscape: {
    flexDirection: "row",
    gap: 4,
    marginTop: 4,
  },
  lotNavBtnLandscape: {
    flex: 1,
    backgroundColor: "rgba(37, 99, 235, 0.9)",
    borderRadius: 8,
    paddingVertical: 8,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  lotNavBtnLandscapeNext: {
    flex: 1,
    backgroundColor: "rgba(16, 185, 129, 0.9)",
    borderRadius: 8,
    paddingVertical: 8,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  lotNavBtnText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "bold",
  },
  zoomLandscape: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 4,
    marginBottom: 2,
  },
  zoomBtnLandscape: {
    padding: 4,
  },
  zoomLabelLandscape: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
    marginHorizontal: 3,
  },
  thumbsLandscape: {
    alignItems: "center",
    marginTop: 4,
    marginBottom: 8,
  },
  thumbLandscape: {
    width: 44,
    height: 44,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#fff",
  },
  thumbCountLandscape: {
    backgroundColor: "#2563EB",
    color: "#fff",
    fontSize: 11,
    fontWeight: "bold",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    marginTop: 4,
    overflow: "hidden",
  },
  capturingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.25)",
    justifyContent: "center",
    alignItems: "center",
  },
  // Permission Screen
  permissionContainer: {
    flex: 1,
    backgroundColor: "#1F2937",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#fff",
    marginTop: 24,
    marginBottom: 12,
  },
  permissionText: {
    fontSize: 16,
    color: "#9CA3AF",
    textAlign: "center",
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 16,
  },
  permissionButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
  cancelButton: {
    padding: 12,
  },
  cancelButtonText: {
    color: "#9CA3AF",
    fontSize: 16,
  },
  // Preview Screen
  previewContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  previewHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
  },
  previewBackBtn: {
    padding: 8,
  },
  previewTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
  previewImage: {
    flex: 1,
    width: "100%",
  },
  previewThumbnails: {
    maxHeight: 80,
    backgroundColor: "rgba(0,0,0,0.8)",
  },
  thumbnailsContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  thumbnail: {
    width: 60,
    height: 60,
    borderRadius: 8,
    marginHorizontal: 4,
    borderWidth: 2,
    borderColor: "transparent",
    overflow: "hidden",
  },
  thumbnailActive: {
    borderColor: "#2563EB",
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
  },
  previewActions: {
    padding: 16,
    backgroundColor: "rgba(0,0,0,0.8)",
  },
  continueBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563EB",
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  continueBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
  // Settings styles
  settingsBtn: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  settingsBtnPortrait: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  enhanceBtnPortrait: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  enhanceBtnPortraitActive: {
    backgroundColor: "rgba(252, 211, 77, 0.35)",
    borderColor: "#FCD34D",
  },
  settingsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 200,
  },
  settingsModal: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    width: "90%",
    maxWidth: 320,
    maxHeight: "85%",
  },
  settingsModalLandscape: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    width: "60%",
    maxWidth: 280,
    maxHeight: "90%",
  },
  settingsCloseBtn: {
    padding: 4,
  },
  settingsContent: {
    flexGrow: 0,
  },
  settingsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  settingsTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#1F2937",
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  settingsRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  settingsRowText: {
    marginLeft: 12,
    flex: 1,
  },
  settingsLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1F2937",
  },
  settingsDesc: {
    fontSize: 12,
    color: "#6B7280",
    marginTop: 2,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#D1D5DB",
    padding: 2,
    justifyContent: "center",
  },
  toggleActive: {
    backgroundColor: "#3B82F6",
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleKnobActive: {
    transform: [{ translateX: 20 }],
  },
  settingsInfo: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 16,
    padding: 12,
    backgroundColor: "#F9FAFB",
    borderRadius: 10,
    gap: 8,
  },
  settingsInfoText: {
    flex: 1,
    fontSize: 12,
    color: "#6B7280",
    lineHeight: 16,
  },
});

export default CameraScreen;
