import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Dimensions,
  Alert,
  Image,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  StatusBar,
  Platform,
  Vibration,
  Animated,
  Linking,
  NativeModules,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Extrapolate,
  interpolate,
  useAnimatedProps,
  useSharedValue,
  runOnJS,
} from 'react-native-reanimated';
import type { CameraProps } from 'react-native-vision-camera';
import {
  Camera,
  useCameraDevice,
  useCameraDevices,
  useCameraPermission,
  useMicrophonePermission,
  VideoFile as VisionVideoFile,
  CameraDevice,
} from 'react-native-vision-camera';
import Slider from '@react-native-community/slider';
import * as MediaLibrary from 'expo-media-library';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MixedLot, CaptureMode, PhotoFile, createNewLot } from './types';
import LotNavigation from './LotNavigation';
import CaptureButtons from './CaptureButtons';
import { TopControls, DoneButton } from './TopControls';
import RecordButton from './RecordButton';
import FocusBox from './FocusBox';
import PhotoThumbnails from './PhotoThumbnails';
import RecordingIndicator from './RecordingIndicator';
import {
  FilterSettings,
  DEFAULT_FILTER_SETTINGS,
  loadFilterSettings,
  saveFilterSettings,
  resetFilterSettings,
} from './filterSettings';

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
type FlashMode = 'off' | 'on' | 'auto';

const ReanimatedCamera = Reanimated.createAnimatedComponent(Camera);
Reanimated.addWhitelistedNativeProps({
  zoom: true,
});

const SCALE_FULL_ZOOM = 3;

const AUTO_ENHANCE_KEY = '@camera_auto_enhance';

type ResolutionPreset = 'auto' | 'max' | number;

const clamp = (value: number, min: number, max: number) => {
  'worklet';
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
  if (!mp || !Number.isFinite(mp)) return '—';
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

const pickBestPhotoFormat = (formats: any[], preset: ResolutionPreset, minRecommendedMP = 10) => {
  if (!Array.isArray(formats) || formats.length === 0) return undefined;

  // For 'max' preset: purely select the highest resolution format, no other penalties
  if (preset === 'max') {
    const sorted = [...formats]
      .map((f) => {
        const w = Number(f?.photoWidth ?? 0);
        const h = Number(f?.photoHeight ?? 0);
        return { f, pixels: w * h };
      })
      .filter((x) => x.pixels > 0)
      .sort((a, b) => b.pixels - a.pixels);
    return sorted[0]?.f;
  }

  const targetPixels = typeof preset === 'number' ? preset * 1_000_000 : undefined;

  const scored = formats
    .map((f) => {
      const w = Number(f?.photoWidth ?? 0);
      const h = Number(f?.photoHeight ?? 0);
      const pixels = w * h;
      const mp = pixels / 1_000_000;
      const aspectPenalty = getAspectPenalty(w, h);
      const smallPenalty = mp < minRecommendedMP ? (minRecommendedMP - mp) * 5 : 0;

      let targetPenalty = 0;
      if (typeof targetPixels === 'number' && Number.isFinite(targetPixels)) {
        const diff = pixels - targetPixels;
        targetPenalty = diff >= 0 ? diff / targetPixels : Math.abs(diff) / targetPixels + 2;
      } else if (preset === 'auto') {
        // Auto: prefer higher MP but with aspect ratio consideration
        targetPenalty = -mp;
      }
      const fpsPenalty = typeof f?.maxFps === 'number' && f.maxFps < 30 ? 2 : 0;

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
    const matchedStandard = STANDARD_MP_VALUES.find((std) => Math.abs(rounded - std) <= 2);
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
  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } =
    useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } =
    useMicrophonePermission();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();

  // Camera ref and device
  const cameraRef = useRef<Camera>(null);

  // Use Triple-Camera (multi-cam) for best quality and smooth zoom transitions
  // This enables ultra-wide (0.5x) + wide (1x) + telephoto (3x) switching
  const deviceMulti = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera', 'telephoto-camera'],
  });

  const deviceWide = useCameraDevice('back', {
    physicalDevices: ['wide-angle-camera'],
  });

  // Fallback for devices without all requested physical cameras (e.g. no telephoto)
  const deviceDefault = useCameraDevice('back');

  // Get ALL available camera devices to find the one with highest resolution
  const allDevices = useCameraDevices();

  const [maxResolutionMode, setMaxResolutionMode] = useState(Platform.OS === 'android');
  const [resolutionPreset, setResolutionPreset] = useState<ResolutionPreset>(
    Platform.OS === 'android' ? 'max' : 'auto'
  );
  const didForceWideForLowResRef = useRef(false);

  // Track camera initialization state for first-install scenario
  const [cameraInitAttempts, setCameraInitAttempts] = useState(0);
  const [cameraInitTimedOut, setCameraInitTimedOut] = useState(false);
  const cameraInitIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Find the absolute best device for max resolution by checking ALL devices
  const bestHighResDevice = useMemo(() => {
    if (!allDevices || allDevices.length === 0) return undefined;

    let bestDevice: CameraDevice | undefined;
    let bestPixels = 0;

    for (const dev of allDevices) {
      if (dev.position !== 'back') continue; // Only back cameras
      for (const fmt of dev.formats ?? []) {
        const pixels = (fmt.photoWidth ?? 0) * (fmt.photoHeight ?? 0);
        if (pixels > bestPixels) {
          bestPixels = pixels;
          bestDevice = dev;
        }
      }
    }

    if (bestDevice) {
      console.log(`[Camera] Best high-res device: ${bestDevice.id}, max pixels: ${bestPixels} (${(bestPixels / 1_000_000).toFixed(1)}MP)`);
    }
    return bestDevice;
  }, [allDevices]);

  // Log all available formats on mount for debugging
  useEffect(() => {
    if (!visible || !allDevices) return;

    console.log('[Camera] === ALL AVAILABLE DEVICES AND FORMATS ==');
    for (const dev of allDevices) {
      if (dev.position !== 'back') continue;
      const formats = dev.formats ?? [];
      const maxFmt = formats.reduce((best, f) => {
        const pixels = (f.photoWidth ?? 0) * (f.photoHeight ?? 0);
        const bestPixels = (best?.photoWidth ?? 0) * (best?.photoHeight ?? 0);
        return pixels > bestPixels ? f : best;
      }, formats[0]);

      console.log(`[Camera] Device: ${dev.id} (${dev.name})`);
      console.log(`[Camera]   Physical: ${(dev as any).physicalDevices?.join(', ') || 'N/A'}`);
      console.log(`[Camera]   Max photo: ${maxFmt?.photoWidth}x${maxFmt?.photoHeight} (${((maxFmt?.photoWidth ?? 0) * (maxFmt?.photoHeight ?? 0) / 1_000_000).toFixed(1)}MP)`);
      console.log(`[Camera]   Total formats: ${formats.length}`);
    }
    console.log('[Camera] === END DEVICES ==');
  }, [visible, allDevices]);

  // Some Android devices expose a low-res multi-cam logical device for photos (e.g. ~3MP).
  // If we detect that the multi/default device can't do reasonable MP, auto-switch to wide once.
  const deviceMultiMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceMulti?.formats ?? []),
    [deviceMulti?.formats]
  );
  const deviceDefaultMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceDefault?.formats ?? []),
    [deviceDefault?.formats]
  );
  const deviceWideMaxMP = useMemo(
    () => getMaxFormatMegapixels(deviceWide?.formats ?? []),
    [deviceWide?.formats]
  );

  const bestDeviceForMaxRes = useMemo(() => {
    const candidates: Array<{ dev: any; mp: number }> = [];
    if (deviceWide && typeof deviceWideMaxMP === 'number') {
      candidates.push({ dev: deviceWide, mp: deviceWideMaxMP });
    }
    if (deviceMulti && typeof deviceMultiMaxMP === 'number') {
      candidates.push({ dev: deviceMulti, mp: deviceMultiMaxMP });
    }
    if (deviceDefault && typeof deviceDefaultMaxMP === 'number') {
      candidates.push({ dev: deviceDefault, mp: deviceDefaultMaxMP });
    }
    candidates.sort((a, b) => b.mp - a.mp);
    return candidates[0]?.dev;
  }, [deviceDefault, deviceDefaultMaxMP, deviceMulti, deviceMultiMaxMP, deviceWide, deviceWideMaxMP]);

  useEffect(() => {
    if (!deviceWide || !deviceWideMaxMP) return;

    const candidateMP = deviceMultiMaxMP ?? deviceDefaultMaxMP ?? 0;
    // If the chosen logical device tops out below ~8MP (or doesn't report), but wide can do 10MP+, force wide.
    const wantsHighResPreset =
      resolutionPreset === 'max' ||
      (typeof resolutionPreset === 'number' && resolutionPreset >= 48);

    if (
      !maxResolutionMode &&
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
    console.log(`[Camera] Device selection: maxResMode=${maxResolutionMode}, preset=${resolutionPreset}`);
    console.log(`[Camera]   bestHighResDevice=${bestHighResDevice?.id ?? 'null'}, deviceWide=${deviceWide?.id ?? 'null'}`);
    
    if (maxResolutionMode && resolutionPreset === 'max') {
      // Priority: bestHighResDevice > deviceWide > bestDeviceForMaxRes > deviceDefault
      if (bestHighResDevice) {
        console.log(`[Camera] SELECTED bestHighResDevice: ${bestHighResDevice.id}`);
        return bestHighResDevice;
      }
      if (deviceWide && typeof deviceWideMaxMP === 'number' && deviceWideMaxMP >= 10) {
        console.log(`[Camera] SELECTED deviceWide: ${deviceWide.id}`);
        return deviceWide;
      }
      if (bestDeviceForMaxRes) {
        console.log(`[Camera] SELECTED bestDeviceForMaxRes: ${bestDeviceForMaxRes.id}`);
        return bestDeviceForMaxRes;
      }
    } else if (maxResolutionMode) {
      if (deviceWide && typeof deviceWideMaxMP === 'number' &&
          deviceWideMaxMP >= (deviceMultiMaxMP ?? 0) &&
          deviceWideMaxMP >= (deviceDefaultMaxMP ?? 0)) {
        console.log(`[Camera] SELECTED deviceWide (maxRes): ${deviceWide.id}`);
        return deviceWide;
      }
      const selected = bestDeviceForMaxRes ?? deviceDefault;
      console.log(`[Camera] SELECTED fallback: ${selected?.id ?? 'null'}`);
      return selected;
    }
    const selected = deviceMulti ?? deviceDefault;
    console.log(`[Camera] SELECTED multi/default: ${selected?.id ?? 'null'}`);
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
            console.warn('[Camera] Camera initialization timed out after 5 seconds');
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
  }, [visible, hasCameraPermission, device, cameraInitAttempts, cameraInitTimedOut]);

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
      console.log(`[Camera] *** ACTIVE DEVICE: ${device.id} (${device.name}) ***`);
      console.log(`[Camera] *** MAX FORMAT: ${maxFmt?.photoWidth}x${maxFmt?.photoHeight} (${((maxFmt?.photoWidth ?? 0) * (maxFmt?.photoHeight ?? 0) / 1_000_000).toFixed(1)}MP) ***`);
    }
  }, [device]);

  const minZoom = useMemo(() => device?.minZoom ?? 1, [device]);
  const maxZoom = useMemo(() => device?.maxZoom ?? 1, [device]);
  const neutralZoom = useMemo(() => device?.neutralZoom ?? 1, [device]);
  // Start at 1x (neutralZoom) - will switch to UW after camera initializes
  // This forces an actual zoom CHANGE which triggers the physical sensor switch
  const zoom = useSharedValue(neutralZoom);
  const pinchStartZoom = useSharedValue(neutralZoom);
  const [currentZoom, setCurrentZoom] = useState(neutralZoom);

  // Available zoom presets based on device capabilities
  const zoomPresets = useMemo(() => {
    const presets: { label: string; value: number }[] = [];
    const physicalDevices = (device as any)?.physicalDevices as string[] | undefined;
    const hasUltraWide = physicalDevices?.includes('ultra-wide-angle-camera') || minZoom < 1;
    const hasTelephoto = physicalDevices?.includes('telephoto-camera');

    // Ultra-wide (0.5x or minZoom)
    if (hasUltraWide && minZoom < neutralZoom) {
      presets.push({ label: 'UW', value: minZoom });
    }

    // Standard 1x (neutralZoom)
    presets.push({ label: '1x', value: neutralZoom });

    // 2x zoom (if available)
    if (maxZoom >= 2) {
      presets.push({ label: '2x', value: 2 });
    }

    // 3x zoom (telephoto or digital)
    if (hasTelephoto || maxZoom >= 3) {
      presets.push({ label: '3x', value: Math.min(3, maxZoom) });
    }

    // 5x zoom if available
    if (maxZoom >= 5) {
      presets.push({ label: '5x', value: 5 });
    }

    return presets;
  }, [device, minZoom, maxZoom, neutralZoom]);

  // Set zoom level with animation feel
  const setZoomLevel = useCallback(
    (level: number) => {
      const clamped = Math.max(minZoom, Math.min(level, maxZoom));
      zoom.value = clamped;
      setCurrentZoom(clamped);
      // Haptic feedback
      if (Platform.OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Vibration.vibrate(15);
      }
    },
    [minZoom, maxZoom, zoom]
  );

  // Update currentZoom when zoom changes (for slider sync)
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentZoom(zoom.value);
    }, 100);
    return () => clearInterval(interval);
  }, [zoom]);

  const cameraAnimatedProps = useAnimatedProps<CameraProps>(() => {
    const z = Math.max(Math.min(zoom.value, maxZoom), minZoom);
    return { zoom: z };
  }, [maxZoom, minZoom]);

  // Screen dimensions for orientation
  const [dimensions, setDimensions] = useState(Dimensions.get('window'));
  const isLandscape = dimensions.width > dimensions.height;

  // Camera settings - Professional grade for iPhone 16 Pro Max / Samsung S24
  const [flash, setFlash] = useState<FlashMode>('off');
  const [focusOn, setFocusOn] = useState(true); // Auto-focus on by default
  const [capturing, setCapturing] = useState(false);
  const [exposure, setExposure] = useState(0); // -1 to 1 range
  const [enableHdr, setEnableHdr] = useState(false);
  const [speedMode, setSpeedMode] = useState(false); // Speed mode OFF by default for full quality
  const [showSettings, setShowSettings] = useState(false); // Settings modal
  const [enhanceOn, setEnhanceOn] = useState(enhanceImages); // Image enhancement toggle

  const [autoEnhanceOn, setAutoEnhanceOn] = useState(Platform.OS === 'android');
  const [autoEnhanceLoaded, setAutoEnhanceLoaded] = useState(false);

  const [showDebug, setShowDebug] = useState(false);
  const [showResolutionPicker, setShowResolutionPicker] = useState(false);

  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterSettings, setFilterSettings] = useState<FilterSettings>(DEFAULT_FILTER_SETTINGS);
  const [filterSettingsLoaded, setFilterSettingsLoaded] = useState(false);
  const [editingPhotoUri, setEditingPhotoUri] = useState<string | null>(null);

  // Load filter settings from AsyncStorage on mount
  useEffect(() => {
    loadFilterSettings().then((settings) => {
      setFilterSettings(settings);
      setFilterSettingsLoaded(true);
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(AUTO_ENHANCE_KEY)
      .then((stored) => {
        if (stored != null) {
          setAutoEnhanceOn(stored === '1' || stored === 'true');
        }
      })
      .catch(() => {})
      .finally(() => setAutoEnhanceLoaded(true));
  }, []);

  useEffect(() => {
    if (!autoEnhanceLoaded) return;
    AsyncStorage.setItem(AUTO_ENHANCE_KEY, autoEnhanceOn ? '1' : '0').catch(() => {});
  }, [autoEnhanceLoaded, autoEnhanceOn]);

  // Save filter settings whenever they change (after initial load)
  useEffect(() => {
    if (filterSettingsLoaded) {
      saveFilterSettings(filterSettings);
    }
  }, [filterSettings, filterSettingsLoaded]);

  const updateFilterSetting = useCallback(
    <K extends keyof FilterSettings>(key: K, value: FilterSettings[K]) => {
      setFilterSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleResetFilters = useCallback(async () => {
    const defaults = await resetFilterSettings();
    setFilterSettings(defaults);
  }, []);

  const [lastCaptureInfo, setLastCaptureInfo] = useState<{
    uri?: string;
    width?: number;
    height?: number;
    megapixels?: number;
  } | null>(null);

  // Camera2 native module for high-res capture on Android
  const [camera2MaxRes, setCamera2MaxRes] = useState<{
    cameraId: string;
    width: number;
    height: number;
    megapixels: number;
  } | null>(null);

  // All available Camera2 resolutions for MP picker
  const [camera2Resolutions, setCamera2Resolutions] = useState<Array<{
    cameraId: string;
    width: number;
    height: number;
    megapixels: number;
  }>>([]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const camera2 = (NativeModules as any)?.Camera2;
    
    // Get max resolution
    if (camera2?.getMaxResolution) {
      camera2.getMaxResolution()
        .then((res: any) => {
          console.log(`[Camera2] Max resolution: ${res.width}x${res.height} (${res.megapixels?.toFixed(1)}MP)`);
          setCamera2MaxRes(res);
        })
        .catch((e: any) => console.warn('[Camera2] Failed to get max resolution:', e));
    }
    
    // Get all available resolutions for MP picker
    if (camera2?.getAllResolutions) {
      camera2.getAllResolutions()
        .then((resolutions: any[]) => {
          console.log(`[Camera2] Available resolutions:`, resolutions.map((r: any) => `${r.megapixels}MP`).join(', '));
          setCamera2Resolutions(resolutions || []);
        })
        .catch((e: any) => console.warn('[Camera2] Failed to get resolutions:', e));
    } else {
      console.log('[Camera2] Native module not available');
    }
  }, []);

  const toggleMaxResolutionMode = useCallback(() => {
    setMaxResolutionMode((prev) => {
      const next = !prev;
      if (next) {
        setSpeedMode(false);
        setEnableHdr(false);
        setFlash('off');
      }
      return next;
    });
  }, []);

  const applyResolutionPreset = useCallback((preset: ResolutionPreset) => {
    setResolutionPreset(preset);

    // High-megapixel modes (48+) generally require wide-only device selection.
    if (preset === 'max' || (typeof preset === 'number' && preset >= 48)) {
      setMaxResolutionMode(true);
    }

    // Low/auto presets should default back to multi-cam (UW/tele switching).
    if (preset === 'auto' || (typeof preset === 'number' && preset <= 12)) {
      setMaxResolutionMode(false);
    }

    // High-res capture should not use speed pipeline.
    if (preset === 'max' || (typeof preset === 'number' && preset >= 48)) {
      setSpeedMode(false);
      setEnableHdr(false);
    }
  }, []);

  const getImageMetaAsync = useCallback(async (uri: string) => {
    return await new Promise<{ width?: number; height?: number; megapixels?: number }>(
      (resolve) => {
        Image.getSize(
          uri,
          (width, height) => {
            resolve({ width, height, megapixels: calcMegapixels(width, height) });
          },
          () => resolve({})
        );
      }
    );
  }, []);

  const updatePhotoAdjustments = useCallback(
    (
      uri: string,
      adjustments: { contrast: number; saturation: number; sharpness: number; detail: number }
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
    [activeLotIdx, setLots]
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

  const toggleAutoEnhance = useCallback(() => {
    setAutoEnhanceOn((p) => !p);
  }, []);

  const saveToGallery = useCallback(
    (uri: string) => {
      if (!mediaPermission?.granted) {
        console.warn('[Camera] Cannot save to gallery: no permission');
        return;
      }
      console.log(`[Camera] Saving to gallery: ${uri.slice(-50)}`);
      MediaLibrary.saveToLibraryAsync(uri)
        .then(() => console.log('[Camera] Saved to gallery successfully'))
        .catch((e) => console.warn('[Camera] Failed to save to gallery:', uri.slice(-50), e));
    },
    [mediaPermission?.granted]
  );

  // Check if AdvancedImageEnhancer native module is available on mount
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const advancedEnhancer: any = (NativeModules as any)?.AdvancedImageEnhancer;
    if (advancedEnhancer?.autoEnhance) {
      console.log('[Camera] AdvancedImageEnhancer native module: AVAILABLE');
    } else {
      console.warn('[Camera] AdvancedImageEnhancer native module: NOT FOUND');
      // Fallback check for old ImageEnhancer
      const oldEnhancer: any = (NativeModules as any)?.ImageEnhancer;
      if (oldEnhancer?.autoEnhance) {
        console.log('[Camera] Fallback ImageEnhancer native module: AVAILABLE');
      } else {
        console.log('[Camera] Available NativeModules:', Object.keys(NativeModules || {}));
      }
    }
  }, []);

  const maybeAutoEnhancePhoto = useCallback(
    (photoUri: string, lotIdx: number, saveAfterEnhance: boolean) => {
      console.log(`[Camera] maybeAutoEnhancePhoto called: autoEnhanceOn=${autoEnhanceOn}, uri=${photoUri.slice(-30)}`);
      
      if (!autoEnhanceOn) {
        console.log('[Camera] Auto-enhance skipped: disabled');
        if (saveAfterEnhance) saveToGallery(photoUri);
        return;
      }
      if (Platform.OS !== 'android') {
        console.log('[Camera] Auto-enhance skipped: not Android');
        if (saveAfterEnhance) saveToGallery(photoUri);
        return;
      }

      // Try AdvancedImageEnhancer first, fallback to old ImageEnhancer
      const advancedEnhancer: any = (NativeModules as any)?.AdvancedImageEnhancer;
      const oldEnhancer: any = (NativeModules as any)?.ImageEnhancer;
      
      const useAdvanced = !!advancedEnhancer?.autoEnhance;
      const enhancer = useAdvanced ? advancedEnhancer : oldEnhancer;
      
      if (!enhancer?.autoEnhance) {
        console.warn('[Camera] Auto-enhance FAILED: No enhancer module found');
        Alert.alert('Enhancement Unavailable', 'Native enhancer module not found. Please rebuild the app.');
        if (saveAfterEnhance) saveToGallery(photoUri);
        return;
      }

      console.log(`[Camera] Starting ${useAdvanced ? 'ADVANCED' : 'basic'} auto-enhance...`);
      const startTime = Date.now();
      
      Promise.resolve(enhancer.autoEnhance(photoUri))
        .then((result: any) => {
          const processingTime = Date.now() - startTime;
          // AdvancedImageEnhancer returns { path, width, height, megapixels, processingTimeMs }
          // Old ImageEnhancer returns just the path string
          const enhancedUri = typeof result === 'string' ? result : result?.path;
          const enhancedPath = enhancedUri?.startsWith('file://') ? enhancedUri : `file://${enhancedUri}`;
          
          console.log(`[Camera] Auto-enhance result (${processingTime}ms): ${enhancedUri ? enhancedUri.slice(-40) : 'null'}`);
          if (result?.width && result?.height) {
            console.log(`[Camera] Enhanced image: ${result.width}x${result.height} (${result.megapixels?.toFixed(1)}MP)`);
          }
          
          if (!enhancedUri || enhancedUri === photoUri) {
            console.log('[Camera] Auto-enhance: no change or same URI');
            if (saveAfterEnhance) saveToGallery(photoUri);
            return;
          }

          console.log('[Camera] Auto-enhance SUCCESS, updating photo URI');
          setLots((prev) => {
            const updated = [...prev];
            const lot = updated[lotIdx];
            if (!lot) return prev;
            const patch = (p: PhotoFile): PhotoFile =>
              p.uri === photoUri
                ? {
                    ...p,
                    uri: enhancedPath,
                  }
                : p;

            updated[lotIdx] = {
              ...lot,
              files: lot.files.map(patch),
              extraFiles: lot.extraFiles.map(patch),
            };
            return updated;
          });

          setLastCaptureInfo((prev) =>
            prev?.uri === photoUri
              ? {
                  ...prev,
                  uri: enhancedPath,
                  width: result?.width ?? prev?.width,
                  height: result?.height ?? prev?.height,
                  megapixels: result?.megapixels ?? prev?.megapixels,
                }
              : prev
          );

          setEditingPhotoUri((prev) => (prev === photoUri ? enhancedPath : prev));

          if (saveAfterEnhance) saveToGallery(enhancedPath);
        })
        .catch((e: any) => {
          console.warn('Auto enhance failed:', e);
          if (saveAfterEnhance) saveToGallery(photoUri);
        });
    },
    [autoEnhanceOn, saveToGallery, setLots]
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

    // Strategy: Camera starts at 1x. After init, we CHANGE to UW.
    // This actual CHANGE triggers the physical sensor switch.
    // (Just starting at UW doesn't work - camera defaults to 1x internally)
    if (device && !maxResolutionMode) {
      const minZ = device.minZoom ?? 1;
      const neutralZ = device.neutralZoom ?? 1;
      const hasUltraWide = minZ < neutralZ;

      if (hasUltraWide) {
        // Wait a moment for camera to fully stabilize at 1x
        setTimeout(() => {
          // Now CHANGE from 1x to UW - this triggers actual sensor switch
          zoom.value = minZ;
          setCurrentZoom(minZ);
          pinchStartZoom.value = minZ;
        }, 200);
      }
    }

    // Release initialZoom control
    setTimeout(() => {
      setInitialZoom(undefined);
    }, 400);
  }, [device, maxResolutionMode, zoom, pinchStartZoom]);

  useEffect(() => {
    if (!visible) return;
    didReleaseInitialZoomRef.current = false;

    if (device) {
      const neutralZ = device.neutralZoom ?? 1;
      // Start at 1x (neutralZoom) - the handleCameraInitialized will switch to UW
      // This ensures an actual CHANGE happens which triggers physical sensor switch
      setInitialZoom(neutralZ);
      zoom.value = neutralZ;
      setCurrentZoom(neutralZ);
    }
  }, [visible, device, zoom]);

  useEffect(() => {
    if (initialZoom !== undefined) {
      zoom.value = initialZoom;
      setCurrentZoom(initialZoom);
    }
  }, [initialZoom, zoom]);

  const toggleSpeedMode = useCallback(() => {
    setSpeedMode((prev) => {
      const next = !prev;
      if (next) {
        setEnableHdr(false);
        setFlash('off');
      }
      return next;
    });
  }, []);

  const toggleHdr = useCallback(() => {
    setEnableHdr((prev) => {
      const next = !prev;
      if (next) setSpeedMode(false);
      return next;
    });
  }, []);

  const availableMPBuckets = useMemo(() => {
    // On Android, use Camera2 resolutions if available
    if (Platform.OS === 'android' && camera2Resolutions.length > 0) {
      const mps = camera2Resolutions
        .map(r => r.megapixels)
        .filter(mp => mp >= 2)
        .sort((a, b) => a - b);
      // Remove duplicates
      const unique = [...new Set(mps)];
      console.log(`[Camera] Using Camera2 MP buckets: ${unique.join(', ')}`);
      return unique;
    }
    // Fallback to VisionCamera formats
    return getAvailableMegapixelBuckets(device?.formats ?? []);
  }, [device?.formats, camera2Resolutions]);

  const selectedFormat = useMemo(() => {
    if (!device?.formats) return undefined;

    // Speed mode should still avoid tiny resolutions (fixes 1-3MP outcomes on some Android devices)
    const minMP = speedMode ? 8 : 10;
    const fmt = pickBestPhotoFormat(device.formats, resolutionPreset, minMP);
    
    // Log selected format for debugging
    if (fmt) {
      console.log(`[Camera] Selected format: ${fmt.photoWidth}x${fmt.photoHeight} (${((fmt.photoWidth ?? 0) * (fmt.photoHeight ?? 0) / 1_000_000).toFixed(1)}MP)`);
    }
    return fmt;
  }, [device?.formats, resolutionPreset, speedMode]);

  // Log all formats available on the device for debugging
  useEffect(() => {
    if (!device?.formats || !visible) return;
    
    const formats = device.formats;
    const sorted = [...formats]
      .map(f => ({ w: f.photoWidth ?? 0, h: f.photoHeight ?? 0 }))
      .sort((a, b) => (b.w * b.h) - (a.w * a.h))
      .slice(0, 5); // Top 5 formats
    
    console.log(`[Camera] Device ${device.id} has ${formats.length} formats. Top 5:`);
    sorted.forEach((f, i) => {
      console.log(`[Camera]   ${i + 1}. ${f.w}x${f.h} (${(f.w * f.h / 1_000_000).toFixed(1)}MP)`);
    });
  }, [device?.formats, device?.id, visible]);

  const format = selectedFormat;

  const effectiveFps = useMemo(() => {
    const desired = 30;
    const max = typeof format?.maxFps === 'number' ? format.maxFps : desired;
    const min = typeof format?.minFps === 'number' ? format.minFps : 1;
    return clamp(desired, min, max);
  }, [format]);

  const selectedFormatMP = useMemo(
    () => calcMegapixels(format?.photoWidth, format?.photoHeight),
    [format?.photoWidth, format?.photoHeight]
  );

  // Safety net: if we still ended up with a tiny selected format (e.g. ~3MP) and wide supports higher, switch.
  useEffect(() => {
    if (!deviceWideMaxMP) return;
    if (!selectedFormatMP) return;
    if (!maxResolutionMode && selectedFormatMP < 8 && deviceWideMaxMP >= 10) {
      setMaxResolutionMode(true);
    }
  }, [deviceWideMaxMP, selectedFormatMP, maxResolutionMode]);

  const presetLabel = useMemo(() => {
    if (resolutionPreset === 'auto') return 'Auto';
    if (resolutionPreset === 'max') return 'Max';
    return `${resolutionPreset}MP`;
  }, [resolutionPreset]);

  const previewMP = useMemo(() => {
    if (!selectedFormatMP) return '—';
    return formatMegapixelsLabel(selectedFormatMP);
  }, [selectedFormatMP]);

  const resolutionPickerModal = (
    <Modal
      transparent
      visible={showResolutionPicker}
      animationType="fade"
      onRequestClose={() => setShowResolutionPicker(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.resolutionModal}>
          <View style={styles.settingsHeader}>
            <Text style={styles.settingsTitle}>Resolution</Text>
            <TouchableOpacity
              onPress={() => setShowResolutionPicker(false)}
              style={styles.settingsCloseBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="x" size={22} color="#1F2937" />
            </TouchableOpacity>
          </View>

          <View style={styles.resolutionButtons}>
            {/* Always show Auto and Max */}
            {(
              [
                { key: 'auto', label: 'Auto' },
                { key: 'max', label: 'Max' },
              ] as Array<{ key: ResolutionPreset; label: string }>
            ).map((opt) => {
              const isActive = resolutionPreset === opt.key;
              return (
                <TouchableOpacity
                  key={String(opt.key)}
                  style={[styles.resolutionBtn, isActive && styles.resolutionBtnActive]}
                  onPress={() => {
                    applyResolutionPreset(opt.key);
                    setShowResolutionPicker(false);
                  }}>
                  <Text
                    style={[styles.resolutionBtnText, isActive && styles.resolutionBtnTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {/* Dynamically show only available MP options */}
            {availableMPBuckets.map((mp) => {
              const isActive = resolutionPreset === mp;
              return (
                <TouchableOpacity
                  key={String(mp)}
                  style={[styles.resolutionBtn, isActive && styles.resolutionBtnActive]}
                  onPress={() => {
                    applyResolutionPreset(mp as ResolutionPreset);
                    setShowResolutionPicker(false);
                  }}>
                  <Text
                    style={[styles.resolutionBtnText, isActive && styles.resolutionBtnTextActive]}>
                    {mp}MP
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.resolutionInfo}>
            <Text style={styles.resolutionInfoText}>Selected format: {previewMP}</Text>
            {availableMPBuckets.length === 0 && (
              <Text style={styles.resolutionInfoSubText}>No standard MP modes detected</Text>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );

  const filterModal = (
    <Modal
      transparent
      visible={showFilterModal}
      animationType="fade"
      onRequestClose={() => setShowFilterModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.filterModal}>
          <View style={styles.settingsHeader}>
            <Text style={styles.settingsTitle}>Image Adjustments</Text>
            <TouchableOpacity
              onPress={() => setShowFilterModal(false)}
              style={styles.settingsCloseBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="x" size={22} color="#1F2937" />
            </TouchableOpacity>
          </View>

          {/* Enable/Disable Toggle */}
          <TouchableOpacity
            style={styles.filterEnableRow}
            onPress={() => updateFilterSetting('enabled', !filterSettings.enabled)}>
            <View style={styles.filterEnableLeft}>
              <Feather
                name="zap"
                size={18}
                color={filterSettings.enabled ? '#10B981' : '#6B7280'}
              />
              <Text style={styles.filterEnableText}>Apply adjustments to photos</Text>
            </View>
            <View style={[styles.toggle, filterSettings.enabled && styles.toggleActive]}>
              <View
                style={[styles.toggleKnob, filterSettings.enabled && styles.toggleKnobActive]}
              />
            </View>
          </TouchableOpacity>

          {editingPhotoUri && (
            <Image
              source={{ uri: editingPhotoUri }}
              style={styles.filterPreview}
              resizeMode="cover"
            />
          )}

          <ScrollView style={styles.filterControls} showsVerticalScrollIndicator={false}>
            {/* Contrast */}
            <View style={styles.filterSliderSection}>
              <View style={styles.filterRow}>
                <Text style={styles.filterLabel}>Contrast</Text>
                <Text style={styles.filterValue}>{filterSettings.contrast.toFixed(2)}</Text>
              </View>
              <Slider
                style={styles.nativeSlider}
                minimumValue={0.5}
                maximumValue={2}
                value={filterSettings.contrast}
                onValueChange={(v) => updateFilterSetting('contrast', v)}
                minimumTrackTintColor="#F43F5E"
                maximumTrackTintColor="#E5E7EB"
                thumbTintColor="#F43F5E"
              />
            </View>

            {/* Saturation */}
            <View style={styles.filterSliderSection}>
              <View style={styles.filterRow}>
                <Text style={styles.filterLabel}>Saturation</Text>
                <Text style={styles.filterValue}>{filterSettings.saturation.toFixed(2)}</Text>
              </View>
              <Slider
                style={styles.nativeSlider}
                minimumValue={0}
                maximumValue={2}
                value={filterSettings.saturation}
                onValueChange={(v) => updateFilterSetting('saturation', v)}
                minimumTrackTintColor="#8B5CF6"
                maximumTrackTintColor="#E5E7EB"
                thumbTintColor="#8B5CF6"
              />
            </View>

            {/* Sharpness */}
            <View style={styles.filterSliderSection}>
              <View style={styles.filterRow}>
                <Text style={styles.filterLabel}>Sharpness</Text>
                <Text style={styles.filterValue}>{filterSettings.sharpness.toFixed(2)}</Text>
              </View>
              <Slider
                style={styles.nativeSlider}
                minimumValue={0}
                maximumValue={2}
                value={filterSettings.sharpness}
                onValueChange={(v) => updateFilterSetting('sharpness', v)}
                minimumTrackTintColor="#3B82F6"
                maximumTrackTintColor="#E5E7EB"
                thumbTintColor="#3B82F6"
              />
            </View>

            {/* Detail */}
            <View style={styles.filterSliderSection}>
              <View style={styles.filterRow}>
                <Text style={styles.filterLabel}>Detail</Text>
                <Text style={styles.filterValue}>{filterSettings.detail.toFixed(2)}</Text>
              </View>
              <Slider
                style={styles.nativeSlider}
                minimumValue={0}
                maximumValue={2}
                value={filterSettings.detail}
                onValueChange={(v) => updateFilterSetting('detail', v)}
                minimumTrackTintColor="#10B981"
                maximumTrackTintColor="#E5E7EB"
                thumbTintColor="#10B981"
              />
            </View>
          </ScrollView>

          <View style={styles.filterActions}>
            <TouchableOpacity style={styles.filterBtnSecondary} onPress={handleResetFilters}>
              <Text style={styles.filterBtnSecondaryText}>Reset All</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.filterBtnPrimary}
              onPress={() => {
                if (editingPhotoUri) {
                  updatePhotoAdjustments(editingPhotoUri, {
                    contrast: filterSettings.contrast,
                    saturation: filterSettings.saturation,
                    sharpness: filterSettings.sharpness,
                    detail: filterSettings.detail,
                  });
                }
                setShowFilterModal(false);
              }}>
              <Text style={styles.filterBtnPrimaryText}>Done</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.filterHint}>
            Settings are saved automatically and applied to all new photos when enabled.
          </Text>
        </View>
      </View>
    </Modal>
  );

  // Video recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [forceVideoUseCase, setForceVideoUseCase] = useState(false);

  const enableVideoUseCase =
    Platform.OS !== 'android' || !maxResolutionMode || forceVideoUseCase || isRecording;

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [selectedPreviewIdx, setSelectedPreviewIdx] = useState(0);

  // Tap-to-focus state
  const [tapFocusPoint, setTapFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const tapFocusAnim = useRef(new Animated.Value(0)).current;

  // Camera active state
  const [isCameraActive, setIsCameraActive] = useState(false);

  // Orientation handling
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setDimensions(window);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (visible) {
      ScreenOrientation.unlockAsync();
      StatusBar.setHidden(true);
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      StatusBar.setHidden(false);
    }
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
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
  }, [visible, hasCameraPermission, hasMicPermission, mediaPermission?.granted]);

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

  // Tap-to-focus handler - Actually focuses the camera at the tap point
  const handleFocusAtPoint = useCallback(
    async (locationX: number, locationY: number) => {
      // Set focus point for visual indicator
      setTapFocusPoint({ x: locationX, y: locationY });

      // Haptic feedback
      if (Platform.OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Vibration.vibrate(25);
      }

      // Actually focus the camera at the tap point
      try {
        if (cameraRef.current && device?.supportsFocus) {
          await cameraRef.current.focus({ x: locationX, y: locationY });
        }
      } catch (error) {
        // Focus may fail on some devices or if camera is busy, silently ignore
        console.log('Focus failed:', error);
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
    },
    [tapFocusAnim, device]
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
          Extrapolate.CLAMP
        );
        zoom.value = interpolate(
          scale,
          [-1, 0, 1],
          [minZoom, pinchStartZoom.value, maxZoom],
          Extrapolate.CLAMP
        );
      });
  }, [isCameraActive, visible, maxZoom, minZoom, pinchStartZoom, zoom]);

  const tapGesture = useMemo(() => {
    return Gesture.Tap()
      .enabled(isCameraActive && visible)
      .maxDuration(250)
      .onEnd((event: any) => {
        runOnJS(handleFocusAtPoint)(event.x, event.y);
      });
  }, [handleFocusAtPoint, isCameraActive, visible]);

  const cameraGestures = useMemo(
    () => Gesture.Simultaneous(pinchGesture, tapGesture),
    [pinchGesture, tapGesture]
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
      // Both modes now use fire-and-forget - no blocking needed

      const currentLot = lots[activeLotIdx];
      if (currentLot?.mode && currentLot.mode !== mode && !isExtra) {
        Alert.alert(
          'Mode Mismatch',
          `This lot uses "${currentLot.mode === 'single_lot' ? 'Bundle' : currentLot.mode === 'per_item' ? 'Per Item' : 'Per Photo'}" mode. Use Extra or go to next lot.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'New Lot', onPress: handleNextLot },
          ]
        );
        return;
      }

      // SPEED MODE: Instant capture - no loading, no blocking, fire-and-forget
      // Allows rapid-fire 5+ photos per second like a shutter burst
      // NOTE: If flash is enabled, we MUST use takePhoto (takeSnapshot doesn't support flash)
      if (speedMode && flash === 'off') {
        // Quick haptic (non-blocking)
        if (Platform.OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } else {
          Vibration.vibrate(25);
        }

        // Fire-and-forget capture - don't await, don't block
        const captureId = Date.now();
        const shouldUseTakePhotoForSpeed =
          Platform.OS === 'android' ||
          maxResolutionMode ||
          resolutionPreset === 'max' ||
          (typeof resolutionPreset === 'number' && resolutionPreset >= 48);

        const capturePromise = shouldUseTakePhotoForSpeed
          ? cameraRef.current.takePhoto({ flash: 'off', enableShutterSound: false })
          : cameraRef.current.takeSnapshot({ quality: 95 });

        capturePromise
          .then(async (photo: any) => {
            const photoUri = `file://${photo.path}`;
            const meta = await getImageMetaAsync(photoUri);
            
            console.log(`[Camera] CAPTURED (speed): ${meta.width}x${meta.height} = ${meta.megapixels?.toFixed(1)}MP`);
            console.log(`[Camera] Expected format: ${format?.photoWidth}x${format?.photoHeight}`);

            const shouldDeferGallerySave =
              Platform.OS === 'android' &&
              autoEnhanceOn &&
              !!((NativeModules as any)?.AdvancedImageEnhancer?.autoEnhance || (NativeModules as any)?.ImageEnhancer?.autoEnhance);

            if (
              Platform.OS === 'android' &&
              !maxResolutionMode &&
              !didForceWideForLowResRef.current &&
              typeof meta.megapixels === 'number' &&
              meta.megapixels < 8 &&
              (deviceWideMaxMP ?? 0) >= 10
            ) {
              didForceWideForLowResRef.current = true;
              setMaxResolutionMode(true);
            }
            const modeLabel =
              mode === 'single_lot' ? 'bundle' : mode === 'per_item' ? 'item' : 'photo';
            const extraLabel = isExtra ? '-extra' : '';
            const fileName = `lot-${activeLotIdx + 1}-${modeLabel}${extraLabel}-${captureId}.jpg`;
            const newPhoto: PhotoFile = {
              uri: photoUri,
              name: fileName,
              type: 'image/jpeg',
              width: meta.width,
              height: meta.height,
              megapixels: meta.megapixels,
              adjustments: filterSettings.enabled
                ? {
                    contrast: filterSettings.contrast,
                    saturation: filterSettings.saturation,
                    sharpness: filterSettings.sharpness,
                    detail: filterSettings.detail,
                  }
                : undefined,
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

            // Save to library (fire-and-forget)
            if (!shouldDeferGallerySave) saveToGallery(photoUri);
            setLastCaptureInfo({ uri: photoUri, ...meta });
            setEditingPhotoUri(photoUri);
            onAutoSave?.();

            maybeAutoEnhancePhoto(photoUri, activeLotIdx, shouldDeferGallerySave);
          })
          .catch((e) => console.warn('Speed capture error:', e));

        return; // Don't block - return immediately for next capture
      }

      // QUALITY MODE: Full native quality burst capture - fire-and-forget like speed mode
      // Uses takePhoto for 100% native sensor quality, no loading/blocking
      // Quick haptic (non-blocking)
      if (Platform.OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Vibration.vibrate(25);
      }

      // Use Camera2 native module ONLY for 'max' resolution mode on Android
      // For other modes, use VisionCamera for faster capture
      const camera2Available = Platform.OS === 'android' && (NativeModules as any)?.Camera2?.takePhoto;
      
      // Only use Camera2 for 'max' preset to get highest resolution
      let camera2Target: { cameraId: string; width: number; height: number } | null = null;
      if (camera2Available && resolutionPreset === 'max' && camera2MaxRes) {
        camera2Target = camera2MaxRes;
      }

      const shouldUseCamera2 = camera2Available && camera2Target && resolutionPreset === 'max';

      if (shouldUseCamera2 && camera2Target) {
        const captureId = Date.now();
        console.log(`[Camera2] Taking photo: ${camera2Target.width}x${camera2Target.height}`);
        
        // Pause VisionCamera to release the camera device
        setIsCameraActive(false);
        
        // Wait for VisionCamera to release the camera
        setTimeout(async () => {
          try {
            const camera2 = (NativeModules as any).Camera2;
            const result = await camera2.takePhoto({
              cameraId: camera2Target!.cameraId,
              width: camera2Target!.width,
              height: camera2Target!.height,
            });
            
            const photoUri = `file://${result.path}`;
            console.log(`[Camera2] CAPTURED: ${result.width}x${result.height} = ${result.megapixels?.toFixed(1)}MP`);

            const shouldDeferGallerySave =
              autoEnhanceOn && !!((NativeModules as any)?.AdvancedImageEnhancer?.autoEnhance || (NativeModules as any)?.ImageEnhancer?.autoEnhance);

            const modeLabel =
              mode === 'single_lot' ? 'bundle' : mode === 'per_item' ? 'item' : 'photo';
            const extraLabel = isExtra ? '-extra' : '';
            const fileName = `lot-${activeLotIdx + 1}-${modeLabel}${extraLabel}-${captureId}.jpg`;
            const newPhoto: PhotoFile = {
              uri: photoUri,
              name: fileName,
              type: 'image/jpeg',
              width: result.width,
              height: result.height,
              megapixels: result.megapixels,
              adjustments: filterSettings.enabled
                ? {
                    contrast: filterSettings.contrast,
                    saturation: filterSettings.saturation,
                    sharpness: filterSettings.sharpness,
                    detail: filterSettings.detail,
                  }
                : undefined,
            };

            setLots((prev) => {
              const updated = [...prev];
              const lot = updated[activeLotIdx];
              if (!lot) return prev;
              if (isExtra) {
                updated[activeLotIdx] = { ...lot, extraFiles: [newPhoto, ...lot.extraFiles] };
              } else {
                updated[activeLotIdx] = { ...lot, mode: mode, files: [newPhoto, ...lot.files] };
              }
              return updated;
            });

            if (!shouldDeferGallerySave) saveToGallery(photoUri);
            setLastCaptureInfo({ uri: photoUri, width: result.width, height: result.height, megapixels: result.megapixels });
            setEditingPhotoUri(photoUri);
            onAutoSave?.();
            maybeAutoEnhancePhoto(photoUri, activeLotIdx, shouldDeferGallerySave);
          } catch (e: any) {
            console.warn('[Camera2] Capture error:', e);
            Alert.alert('Camera2 Error', `High-res capture failed: ${e?.message || e}`);
          } finally {
            // Resume VisionCamera
            setTimeout(() => setIsCameraActive(true), 300);
          }
        }, 400);
        return;
      }

      // Fire-and-forget capture with full native quality (max resolution for S24, etc.)
      const captureId = Date.now();
      console.log(`[Camera] Taking photo with format: ${format?.photoWidth}x${format?.photoHeight}`);
      cameraRef.current
        .takePhoto({
          flash: flash,
          enableShutterSound: false,
        })
        .then(async (photo) => {
          const photoUri = `file://${photo.path}`;
          const meta = await getImageMetaAsync(photoUri);
          
          console.log(`[Camera] CAPTURED (quality): ${meta.width}x${meta.height} = ${meta.megapixels?.toFixed(1)}MP`);
          console.log(`[Camera] Expected format: ${format?.photoWidth}x${format?.photoHeight}`);

          const shouldDeferGallerySave =
            Platform.OS === 'android' &&
            autoEnhanceOn &&
            !!((NativeModules as any)?.AdvancedImageEnhancer?.autoEnhance || (NativeModules as any)?.ImageEnhancer?.autoEnhance);

          if (
            Platform.OS === 'android' &&
            !maxResolutionMode &&
            !didForceWideForLowResRef.current &&
            typeof meta.megapixels === 'number' &&
            meta.megapixels < 8 &&
            (deviceWideMaxMP ?? 0) >= 10
          ) {
            didForceWideForLowResRef.current = true;
            setMaxResolutionMode(true);
          }
          const modeLabel =
            mode === 'single_lot' ? 'bundle' : mode === 'per_item' ? 'item' : 'photo';
          const extraLabel = isExtra ? '-extra' : '';
          const fileName = `lot-${activeLotIdx + 1}-${modeLabel}${extraLabel}-${captureId}.jpg`;
          const newPhoto: PhotoFile = {
            uri: photoUri,
            name: fileName,
            type: 'image/jpeg',
            width: meta.width,
            height: meta.height,
            megapixels: meta.megapixels,
            adjustments: filterSettings.enabled
              ? {
                  contrast: filterSettings.contrast,
                  saturation: filterSettings.saturation,
                  sharpness: filterSettings.sharpness,
                  detail: filterSettings.detail,
                }
              : undefined,
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
          if (!shouldDeferGallerySave) saveToGallery(photoUri);
          setLastCaptureInfo({ uri: photoUri, ...meta });
          setEditingPhotoUri(photoUri);
          onAutoSave?.();

          maybeAutoEnhancePhoto(photoUri, activeLotIdx, shouldDeferGallerySave);
        })
        .catch((e) => console.warn('Quality capture error:', e));
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
      speedMode,
      maxResolutionMode,
      deviceWideMaxMP,
      resolutionPreset,
      filterSettings,
      getImageMetaAsync,
      maybeAutoEnhancePhoto,
      autoEnhanceOn,
      saveToGallery,
      camera2MaxRes,
      camera2Resolutions,
      format,
      setIsCameraActive,
    ]
  );

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || isRecording) return;

    const currentLot = lots[activeLotIdx];
    if (!currentLot?.mode) {
      Alert.alert('Select Mode', 'Capture at least one photo first to set the lot mode.');
      return;
    }

    try {
      if (Platform.OS === 'android' && maxResolutionMode && !enableVideoUseCase) {
        setForceVideoUseCase(true);
        await new Promise((r) => setTimeout(r, 250));
      }

      setIsRecording(true);
      setRecordingTime(0);

      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      // react-native-vision-camera video recording
      // 4K video recording for professional quality
      cameraRef.current.startRecording({
        flash: flash === 'auto' ? 'off' : flash, // Video only supports 'on' | 'off'
        onRecordingFinished: async (video: VisionVideoFile) => {
          const videoUri = `file://${video.path}`;

          if (videoUri) {
            const fileName = `lot-${activeLotIdx + 1}-video-${Date.now()}.mp4`;
            const newVideo: PhotoFile = {
              uri: videoUri,
              name: fileName,
              type: 'video/mp4',
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
                console.warn('Failed to save video:', e);
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
          console.error('Recording error:', error);
          setIsRecording(false);
          setForceVideoUseCase(false);
          if (recordingIntervalRef.current) {
            clearInterval(recordingIntervalRef.current);
            recordingIntervalRef.current = null;
          }
        },
      });
    } catch (e: any) {
      console.error('Recording start error:', e);
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

  const stopRecording = useCallback(async () => {
    if (cameraRef.current && isRecording) {
      await cameraRef.current.stopRecording();
    }
  }, [isRecording]);

  const toggleFlash = useCallback(() => {
    setFlash((current) => {
      let next: FlashMode;
      switch (current) {
        case 'off':
          next = 'on';
          break;
        case 'on':
          next = 'auto';
          break;
        case 'auto':
          next = 'off';
          break;
        default:
          next = 'off';
      }
      // When flash is enabled, auto-switch to quality mode (flash requires takePhoto)
      if (next !== 'off') {
        setSpeedMode(false);
      }
      return next;
    });
  }, []);

  const currentLot = lots[activeLotIdx];
  const allPhotos: PhotoFile[] = currentLot ? [...currentLot.files, ...currentLot.extraFiles] : [];

  if (!visible) return null;

  // Permission screen
  if (!hasCameraPermission) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <SafeAreaView style={styles.permissionContainer} edges={['top', 'bottom', 'left', 'right']}>
          <Feather name="camera-off" size={64} color="#9CA3AF" />
          <Text style={styles.permissionTitle}>Camera Permission Required</Text>
          <Text style={styles.permissionText}>Please grant camera access to capture photos.</Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestCameraPermission}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={() => Linking.openSettings()}>
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
        <SafeAreaView style={styles.permissionContainer} edges={['top', 'bottom', 'left', 'right']}>
          {cameraInitTimedOut ? (
            <>
              <Feather name="camera-off" size={64} color="#EF4444" />
              <Text style={styles.permissionTitle}>No Camera Found</Text>
              <Text style={styles.permissionText}>
                Unable to access camera device. Please try closing and reopening the camera.
              </Text>
              <TouchableOpacity
                style={[styles.permissionButton, { marginTop: 20 }]}
                onPress={() => {
                  // Reset and try again
                  setCameraInitAttempts(0);
                  setCameraInitTimedOut(false);
                }}>
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
                Please wait while we set up your camera.{cameraInitAttempts > 0 ? ` (${cameraInitAttempts}/10)` : ''}
              </Text>
              <TouchableOpacity style={[styles.cancelButton, { marginTop: 20 }]} onPress={onClose}>
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
      <Modal visible={visible} animationType="fade" onRequestClose={() => setShowPreview(false)}>
        <View
          style={[
            styles.previewContainer,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}>
          <View style={styles.previewHeader}>
            <TouchableOpacity onPress={() => setShowPreview(false)} style={styles.previewBackBtn}>
              <Feather name="arrow-left" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.previewTitle}>
              Lot {activeLotIdx + 1} - {selectedPreviewIdx + 1}/{allPhotos.length}
            </Text>
            <View style={{ width: 40 }} />
          </View>

          <Image
            source={{ uri: allPhotos[selectedPreviewIdx]?.uri }}
            style={styles.previewImage}
            resizeMode="contain"
          />

          <ScrollView
            horizontal
            style={styles.previewThumbnails}
            contentContainerStyle={styles.thumbnailsContent}
            showsHorizontalScrollIndicator={false}>
            {allPhotos.map((item, index) => (
              <TouchableOpacity
                key={`thumb-${index}`}
                onPress={() => setSelectedPreviewIdx(index)}
                style={[styles.thumbnail, index === selectedPreviewIdx && styles.thumbnailActive]}>
                <Image source={{ uri: item.uri }} style={styles.thumbnailImage} />
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={[styles.previewActions, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <TouchableOpacity style={styles.continueBtn} onPress={() => setShowPreview(false)}>
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
        supportedOrientations={['portrait', 'landscape']}>
        <View style={styles.container}>
          <GestureDetector gesture={cameraGestures}>
            <Reanimated.View style={styles.cameraWrapper}>
              <ReanimatedCamera
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
                animatedProps={cameraAnimatedProps}
                fps={effectiveFps}
                enableBufferCompression={speedMode}
                photoQualityBalance={speedMode ? 'speed' : 'quality'}
                photoHdr={!speedMode && enableHdr && format?.supportsPhotoHdr}
                videoHdr={!speedMode && enableHdr && format?.supportsVideoHdr}
                videoBitRate="high"
              />
              <View style={StyleSheet.absoluteFill}>
                <FocusBox visible={focusOn} isLandscape={false} />
                <RecordingIndicator isRecording={isRecording} recordingTime={recordingTime} />

                {showDebug && (
                  <View style={[styles.debugOverlay, { top: insets.top + 58 }]}>
                    <Text style={styles.debugText}>
                      Preset: {presetLabel} | Format: {previewMP}
                    </Text>
                    <Text style={styles.debugText}>
                      WideMax: {formatMegapixelsLabel(deviceWideMaxMP)} | MultiMax:{' '}
                      {formatMegapixelsLabel(deviceMultiMaxMP)} | DefaultMax:{' '}
                      {formatMegapixelsLabel(deviceDefaultMaxMP)}
                    </Text>
                    <Text style={styles.debugText}>
                      Buckets: {availableMPBuckets.length ? availableMPBuckets.join(',') : '—'}
                    </Text>
                    <Text style={styles.debugText}>
                      VideoUC: {enableVideoUseCase ? 'on' : 'off'}
                    </Text>
                    <Text style={styles.debugText}>
                      Photo: {String(format?.photoWidth ?? '—')}x{String(format?.photoHeight ?? '—')} | Video:{' '}
                      {String(format?.videoWidth ?? '—')}x{String(format?.videoHeight ?? '—')} | FPS:{' '}
                      {String(format?.minFps ?? '—')}-{String(format?.maxFps ?? '—')}
                    </Text>
                    <Text style={styles.debugText}>
                      Device: {String((device as any)?.name ?? (device as any)?.id ?? '—')} | Phys:{' '}
                      {Array.isArray((device as any)?.physicalDevices)
                        ? (device as any).physicalDevices.join(',')
                        : '—'}
                    </Text>
                    <Text style={styles.debugText}>Zoom: {currentZoom.toFixed(2)}x</Text>
                    <Text style={styles.debugText}>
                      Last: {lastCaptureInfo?.width ?? '—'}x{lastCaptureInfo?.height ?? '—'} (
                      {formatMegapixelsLabel(lastCaptureInfo?.megapixels)})
                    </Text>
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
                <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
                  <DoneButton onDone={onClose} />
                  <LotNavigation
                    lots={lots}
                    activeLotIdx={activeLotIdx}
                    onPrevLot={handlePrevLot}
                    onNextLot={handleNextLot}
                  />
                  <TopControls
                    flash={flash}
                    focusOn={focusOn}
                    onFlashToggle={toggleFlash}
                    onFocusToggle={() => setFocusOn(!focusOn)}
                    onDone={onClose}
                  />
                </View>

                {/* Bottom Controls - Compact stacked layout */}
                <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 6 }]}>
                  {/* Row 0: Close button and Zoom Sensors */}
                  <View style={styles.bottomBarTopRow}>
                    <TouchableOpacity onPress={onClose} style={styles.closeBtnPortrait}>
                      <Feather name="x" size={18} color="#fff" />
                    </TouchableOpacity>
                    <View style={styles.zoomPresetsInline}>
                      {zoomPresets.map((preset) => {
                        const isActive = Math.abs(currentZoom - preset.value) < 0.1;
                        return (
                          <TouchableOpacity
                            key={preset.label}
                            style={[
                              styles.zoomPresetBtnSmall,
                              isActive && styles.zoomPresetBtnActiveSmall,
                            ]}
                            onPress={() => setZoomLevel(preset.value)}>
                            <Text
                              style={[
                                styles.zoomPresetTextSmall,
                                isActive && styles.zoomPresetTextActiveSmall,
                              ]}>
                              {preset.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <TouchableOpacity
                      style={styles.settingsBtnPortrait}
                      onPress={() => setShowSettings(true)}>
                      <Feather name="settings" size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                  {/* Row 1: Capture buttons */}
                  <View style={styles.bottomBarRow}>
                    <CaptureButtons onCapture={handleCapture} disabled={capturing} />
                  </View>
                  {/* Row 2: Thumbnails, Record, Enhance */}
                  <View style={styles.bottomBarControls}>
                    <PhotoThumbnails photos={allPhotos} onPress={() => setShowPreview(true)} />
                    <RecordButton
                      isRecording={isRecording}
                      onStartRecording={startRecording}
                      onStopRecording={stopRecording}
                      disabled={!currentLot?.mode}
                    />
                    <TouchableOpacity
                      style={[
                        styles.enhanceBtnPortrait,
                        enhanceOn && styles.enhanceBtnPortraitActive,
                      ]}
                      onPress={toggleEnhance}>
                      <Feather name="star" size={16} color={enhanceOn ? '#FCD34D' : '#fff'} />
                    </TouchableOpacity>
                  </View>
                </View>

                {capturing && (
                  <View style={styles.capturingOverlay}>
                    <ActivityIndicator color="#fff" size="large" />
                  </View>
                )}

                {resolutionPickerModal}
                {filterModal}

                {/* Settings Modal */}
                {showSettings && (
                  <View style={styles.settingsOverlay}>
                    <View style={styles.settingsModal}>
                      <View style={styles.settingsHeader}>
                        <Text style={styles.settingsTitle}>Settings</Text>
                        <TouchableOpacity
                          onPress={() => setShowSettings(false)}
                          style={styles.settingsCloseBtn}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                          <Feather name="x" size={22} color="#1F2937" />
                        </TouchableOpacity>
                      </View>

                      <ScrollView
                        style={styles.settingsContent}
                        showsVerticalScrollIndicator={false}
                        bounces={false}>
                        <TouchableOpacity
                          style={styles.settingsRow}
                          onPress={() => {
                            setShowResolutionPicker(true);
                          }}>
                          <View style={styles.settingsRowLeft}>
                            <Feather name="image" size={18} color="#6B7280" />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Resolution</Text>
                              <Text style={styles.settingsDesc}>
                                {presetLabel} ({previewMP})
                              </Text>
                            </View>
                          </View>
                          <Feather name="chevron-right" size={18} color="#9CA3AF" />
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.settingsRow}
                          onPress={() => {
                            setEditingPhotoUri(lastCaptureInfo?.uri ?? allPhotos?.[0]?.uri ?? null);
                            setShowFilterModal(true);
                          }}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="sliders"
                              size={18}
                              color={filterSettings.enabled ? '#10B981' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Image Adjustments</Text>
                              <Text style={styles.settingsDesc}>
                                {filterSettings.enabled ? 'Enabled' : 'Disabled'} • C:
                                {filterSettings.contrast.toFixed(1)} S:
                                {filterSettings.saturation.toFixed(1)} Sh:
                                {filterSettings.sharpness.toFixed(1)} D:
                                {filterSettings.detail.toFixed(1)}
                              </Text>
                            </View>
                          </View>
                          <Feather name="chevron-right" size={18} color="#9CA3AF" />
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.settingsRow}
                          onPress={() => setShowDebug((p) => !p)}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="info"
                              size={18}
                              color={showDebug ? '#3B82F6' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Debug Overlay</Text>
                              <Text style={styles.settingsDesc}>
                                Show device/format/capture info
                              </Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, showDebug && styles.toggleActive]}>
                            <View
                              style={[styles.toggleKnob, showDebug && styles.toggleKnobActive]}
                            />
                          </View>
                        </TouchableOpacity>

                        {/* Speed Mode Toggle */}
                        <TouchableOpacity style={styles.settingsRow} onPress={toggleSpeedMode}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="zap"
                              size={18}
                              color={speedMode ? '#F59E0B' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Speed Mode</Text>
                              <Text style={styles.settingsDesc}>Burst capture, no delay</Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, speedMode && styles.toggleActive]}>
                            <View
                              style={[styles.toggleKnob, speedMode && styles.toggleKnobActive]}
                            />
                          </View>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.settingsRow}
                          onPress={toggleMaxResolutionMode}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="maximize"
                              size={18}
                              color={maxResolutionMode ? '#10B981' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Max Resolution</Text>
                              <Text style={styles.settingsDesc}>
                                Wide 1x only (best MP/quality)
                              </Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, maxResolutionMode && styles.toggleActive]}>
                            <View
                              style={[
                                styles.toggleKnob,
                                maxResolutionMode && styles.toggleKnobActive,
                              ]}
                            />
                          </View>
                        </TouchableOpacity>

                        {Platform.OS === 'android' && (
                          <TouchableOpacity style={styles.settingsRow} onPress={toggleAutoEnhance}>
                            <View style={styles.settingsRowLeft}>
                              <Feather
                                name="aperture"
                                size={18}
                                color={autoEnhanceOn ? '#10B981' : '#6B7280'}
                              />
                              <View style={styles.settingsRowText}>
                                <Text style={styles.settingsLabel}>Auto Enhance</Text>
                                <Text style={styles.settingsDesc}>Fast native enhancement</Text>
                              </View>
                            </View>
                            <View style={[styles.toggle, autoEnhanceOn && styles.toggleActive]}>
                              <View
                                style={[
                                  styles.toggleKnob,
                                  autoEnhanceOn && styles.toggleKnobActive,
                                ]}
                              />
                            </View>
                          </TouchableOpacity>
                        )}

                        {/* HDR Toggle */}
                        <TouchableOpacity style={styles.settingsRow} onPress={toggleHdr}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="sun"
                              size={18}
                              color={enableHdr ? '#3B82F6' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>HDR</Text>
                              <Text style={styles.settingsDesc}>High Dynamic Range</Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, enableHdr && styles.toggleActive]}>
                            <View
                              style={[styles.toggleKnob, enableHdr && styles.toggleKnobActive]}
                            />
                          </View>
                        </TouchableOpacity>

                        {/* Focus Box Toggle */}
                        <TouchableOpacity
                          style={[styles.settingsRow, { borderBottomWidth: 0 }]}
                          onPress={() => setFocusOn(!focusOn)}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="crosshair"
                              size={18}
                              color={focusOn ? '#10B981' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Focus Guide</Text>
                              <Text style={styles.settingsDesc}>Show focus overlay</Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, focusOn && styles.toggleActive]}>
                            <View style={[styles.toggleKnob, focusOn && styles.toggleKnobActive]} />
                          </View>
                        </TouchableOpacity>
                      </ScrollView>
                    </View>
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
    if (!mode) return '—';
    return mode === 'single_lot' ? 'Bundle' : mode === 'per_item' ? 'Per Item' : 'Per Photo';
  };

  // Main camera view - Landscape (controls on right side like web MixedSection)
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.container}>
        <GestureDetector gesture={cameraGestures}>
          <Reanimated.View style={styles.cameraWrapper}>
            <ReanimatedCamera
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
              animatedProps={cameraAnimatedProps}
              fps={effectiveFps}
              enableBufferCompression={speedMode}
              photoQualityBalance={speedMode ? 'speed' : 'quality'}
              photoHdr={!speedMode && enableHdr && format?.supportsPhotoHdr}
              videoHdr={!speedMode && enableHdr && format?.supportsVideoHdr}
              videoBitRate="high"
            />

            <View style={StyleSheet.absoluteFill}>
              <FocusBox visible={focusOn} isLandscape={true} />
              <RecordingIndicator isRecording={isRecording} recordingTime={recordingTime} />

              {showDebug && (
                <View
                  style={[
                    styles.debugOverlay,
                    {
                      top: Math.max(insets.top, 4) + 42,
                      left: Math.max(insets.left, 8),
                      right: Math.max(insets.right, 4) + 95,
                    },
                  ]}>
                  <Text style={styles.debugText}>
                    Preset: {presetLabel} | Format: {previewMP}
                  </Text>
                  <Text style={styles.debugText}>
                    WideMax: {formatMegapixelsLabel(deviceWideMaxMP)} | MultiMax:{' '}
                    {formatMegapixelsLabel(deviceMultiMaxMP)} | DefaultMax:{' '}
                    {formatMegapixelsLabel(deviceDefaultMaxMP)}
                  </Text>
                  <Text style={styles.debugText}>
                    Buckets: {availableMPBuckets.length ? availableMPBuckets.join(',') : '—'}
                  </Text>
                  <Text style={styles.debugText}>
                    Photo: {String(format?.photoWidth ?? '—')}x{String(format?.photoHeight ?? '—')}{' '}
                    | Video: {String(format?.videoWidth ?? '—')}x
                    {String(format?.videoHeight ?? '—')} | FPS: {String(format?.minFps ?? '—')}-
                    {String(format?.maxFps ?? '—')}
                  </Text>
                  <Text style={styles.debugText}>
                    Device: {String((device as any)?.name ?? (device as any)?.id ?? '—')} | Phys:{' '}
                    {Array.isArray((device as any)?.physicalDevices)
                      ? (device as any).physicalDevices.join(',')
                      : '—'}
                  </Text>
                  <Text style={styles.debugText}>Zoom: {currentZoom.toFixed(2)}x</Text>
                  <Text style={styles.debugText}>
                    Last: {lastCaptureInfo?.width ?? '—'}x{lastCaptureInfo?.height ?? '—'} (
                    {formatMegapixelsLabel(lastCaptureInfo?.megapixels)})
                  </Text>
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

              {/* Top Bar in Landscape - Compact like web */}
              <View
                style={[
                  styles.topBarLandscape,
                  {
                    paddingTop: Math.max(insets.top, 4),
                    paddingLeft: Math.max(insets.left, 8),
                    paddingRight: Math.max(insets.right, 4) + 95,
                  },
                ]}>
                {/* Exit Button */}
                <TouchableOpacity onPress={onClose} style={styles.exitBtnLandscape}>
                  <Feather name="x" size={16} color="#fff" />
                  <Text style={styles.exitBtnText}>Exit</Text>
                </TouchableOpacity>

                {/* Center Info - Compact */}
                <View style={styles.landscapeCenterInfo}>
                  <Text style={styles.landscapeInfoText} numberOfLines={1}>
                    Lot {activeLotIdx + 1} | {currentLot?.files.length ?? 0} main |{' '}
                    {currentLot?.extraFiles.length ?? 0} extra | {getModeLabel(currentLot?.mode)}
                    {isRecording && ' | REC'}
                  </Text>
                </View>

                {/* Right Controls - Flash, Focus, Image Thumbnails */}
                <View style={styles.landscapeTopControls}>
                  <TouchableOpacity onPress={toggleFlash} style={styles.topControlBtn}>
                    <Feather
                      name={flash === 'off' ? 'zap-off' : 'zap'}
                      size={14}
                      color={flash === 'on' ? '#FCD34D' : '#fff'}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setFocusOn(!focusOn)}
                    style={[styles.topControlBtn, focusOn && styles.topControlBtnActive]}>
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

              {/* Right Side Controls Panel - Like web MixedSection landscape */}
              <View
                style={[
                  styles.rightPanel,
                  {
                    right: Math.max(insets.right, 2),
                    top: Math.max(insets.top, 4) + 38,
                    bottom: Math.max(insets.bottom, 4),
                  },
                ]}>
                <View style={styles.rightPanelContent}>
                  {/* Capture Buttons - Bundle Row */}
                  <View style={styles.captureRowLandscape}>
                    <TouchableOpacity
                      style={styles.captureBtnMainLandscape}
                      onPress={() => handleCapture('single_lot', false)}
                      disabled={capturing}>
                      <Feather name="camera" size={12} color="#fff" />
                      <Text style={styles.captureBtnTextLandscape}>Bundle</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.captureBtnExtraLandscape}
                      onPress={() => handleCapture('single_lot', true)}
                      disabled={capturing}>
                      <Text style={styles.captureBtnTextLandscape}>Extra</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Capture Buttons - Item Row */}
                  <View style={styles.captureRowLandscape}>
                    <TouchableOpacity
                      style={styles.captureBtnMainLandscape}
                      onPress={() => handleCapture('per_item', false)}
                      disabled={capturing}>
                      <Feather name="camera" size={12} color="#fff" />
                      <Text style={styles.captureBtnTextLandscape}>Item</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.captureBtnExtraLandscape}
                      onPress={() => handleCapture('per_item', true)}
                      disabled={capturing}>
                      <Text style={styles.captureBtnTextLandscape}>Extra</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Capture Buttons - Photo Row */}
                  <View style={styles.captureRowLandscape}>
                    <TouchableOpacity
                      style={styles.captureBtnMainLandscape}
                      onPress={() => handleCapture('per_photo', false)}
                      disabled={capturing}>
                      <Feather name="camera" size={12} color="#fff" />
                      <Text style={styles.captureBtnTextLandscape}>Photo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.captureBtnExtraLandscape}
                      onPress={() => handleCapture('per_photo', true)}
                      disabled={capturing}>
                      <Text style={styles.captureBtnTextLandscape}>Extra</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Record Button */}
                  <TouchableOpacity
                    style={[
                      styles.recordBtnLandscape,
                      isRecording && styles.recordBtnActiveLandscape,
                      !currentLot?.mode && styles.recordBtnDisabledLandscape,
                    ]}
                    onPress={isRecording ? stopRecording : startRecording}
                    disabled={!currentLot?.mode}>
                    <Text style={styles.recordBtnTextLandscape}>
                      {isRecording ? 'Stop' : 'Record'}
                    </Text>
                  </TouchableOpacity>

                  {/* Zoom Presets - Landscape (all sensors) */}
                  <View style={styles.zoomPresetsLandscape}>
                    {zoomPresets.map((preset) => {
                      const isActive = Math.abs(currentZoom - preset.value) < 0.1;
                      return (
                        <TouchableOpacity
                          key={preset.label}
                          style={[
                            styles.zoomPresetBtnLandscape,
                            isActive && styles.zoomPresetBtnActiveLandscape,
                          ]}
                          onPress={() => setZoomLevel(preset.value)}>
                          <Text
                            style={[
                              styles.zoomPresetTextLandscape,
                              isActive && styles.zoomPresetTextActiveLandscape,
                            ]}>
                            {preset.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Prev/Next Lot Navigation */}
                  <View style={styles.lotNavLandscape}>
                    <TouchableOpacity
                      onPress={handlePrevLot}
                      disabled={activeLotIdx <= 0}
                      style={[
                        styles.lotNavBtnLandscape,
                        activeLotIdx <= 0 && styles.lotNavBtnDisabled,
                      ]}>
                      <Text style={styles.lotNavBtnText}>◀ Prev</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleNextLot} style={styles.lotNavBtnLandscapeNext}>
                      <Text style={styles.lotNavBtnText}>Next ▶</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Settings & Enhance Row */}
                  <View style={styles.actionRowLandscape}>
                    <TouchableOpacity
                      style={styles.settingsBtnLandscape}
                      onPress={() => setShowSettings(true)}>
                      <Feather name="settings" size={14} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.enhanceBtnLandscape,
                        enhanceOn && styles.enhanceBtnLandscapeActive,
                      ]}
                      onPress={toggleEnhance}>
                      <Feather name="star" size={14} color={enhanceOn ? '#FCD34D' : '#fff'} />
                    </TouchableOpacity>
                  </View>

                  {/* Done Button - Full Width */}
                  <TouchableOpacity style={styles.doneBtnLandscapeFull} onPress={onClose}>
                    <Feather name="check" size={16} color="#fff" />
                    <Text style={styles.doneBtnTextLandscapeFull}>Done</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {capturing && (
                <View style={styles.capturingOverlay}>
                  <ActivityIndicator color="#fff" size="large" />
                </View>
              )}

              {resolutionPickerModal}
              {filterModal}

              {/* Settings Modal - Landscape */}
              {showSettings && (
                <View style={styles.settingsOverlay}>
                  <View style={styles.settingsModalLandscape}>
                    <View style={styles.settingsHeader}>
                      <Text style={styles.settingsTitle}>Settings</Text>
                      <TouchableOpacity
                        onPress={() => setShowSettings(false)}
                        style={styles.settingsCloseBtn}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                        <Feather name="x" size={22} color="#1F2937" />
                      </TouchableOpacity>
                    </View>

                    <ScrollView
                      style={styles.settingsContent}
                      showsVerticalScrollIndicator={false}
                      bounces={false}>
                      <TouchableOpacity
                        style={styles.settingsRow}
                        onPress={() => {
                          setShowResolutionPicker(true);
                        }}>
                        <View style={styles.settingsRowLeft}>
                          <Feather name="image" size={18} color="#6B7280" />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Resolution</Text>
                            <Text style={styles.settingsDesc}>
                              {presetLabel} ({previewMP})
                            </Text>
                          </View>
                        </View>
                        <Feather name="chevron-right" size={18} color="#9CA3AF" />
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.settingsRow}
                        onPress={() => {
                          setEditingPhotoUri(lastCaptureInfo?.uri ?? allPhotos?.[0]?.uri ?? null);
                          setShowFilterModal(true);
                        }}>
                        <View style={styles.settingsRowLeft}>
                          <Feather
                            name="sliders"
                            size={18}
                            color={filterSettings.enabled ? '#10B981' : '#6B7280'}
                          />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Image Adjustments</Text>
                            <Text style={styles.settingsDesc}>
                              {filterSettings.enabled ? 'Enabled' : 'Disabled'} • C:
                              {filterSettings.contrast.toFixed(1)} S:
                              {filterSettings.saturation.toFixed(1)}
                            </Text>
                          </View>
                        </View>
                        <Feather name="chevron-right" size={18} color="#9CA3AF" />
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.settingsRow}
                        onPress={() => setShowDebug((p) => !p)}>
                        <View style={styles.settingsRowLeft}>
                          <Feather
                            name="info"
                            size={18}
                            color={showDebug ? '#3B82F6' : '#6B7280'}
                          />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Debug Overlay</Text>
                            <Text style={styles.settingsDesc}>Show device/format/capture info</Text>
                          </View>
                        </View>
                        <View style={[styles.toggle, showDebug && styles.toggleActive]}>
                          <View style={[styles.toggleKnob, showDebug && styles.toggleKnobActive]} />
                        </View>
                      </TouchableOpacity>

                      {/* Speed Mode Toggle */}
                      <TouchableOpacity style={styles.settingsRow} onPress={toggleSpeedMode}>
                        <View style={styles.settingsRowLeft}>
                          <Feather name="zap" size={18} color={speedMode ? '#F59E0B' : '#6B7280'} />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Speed Mode</Text>
                            <Text style={styles.settingsDesc}>Burst capture</Text>
                          </View>
                        </View>
                        <View style={[styles.toggle, speedMode && styles.toggleActive]}>
                          <View style={[styles.toggleKnob, speedMode && styles.toggleKnobActive]} />
                        </View>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.settingsRow}
                        onPress={toggleMaxResolutionMode}>
                        <View style={styles.settingsRowLeft}>
                          <Feather
                            name="maximize"
                            size={18}
                            color={maxResolutionMode ? '#10B981' : '#6B7280'}
                          />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Max Resolution</Text>
                            <Text style={styles.settingsDesc}>Wide 1x only (best MP/quality)</Text>
                          </View>
                        </View>
                        <View style={[styles.toggle, maxResolutionMode && styles.toggleActive]}>
                          <View
                            style={[
                              styles.toggleKnob,
                              maxResolutionMode && styles.toggleKnobActive,
                            ]}
                          />
                        </View>
                      </TouchableOpacity>

                      {Platform.OS === 'android' && (
                        <TouchableOpacity style={styles.settingsRow} onPress={toggleAutoEnhance}>
                          <View style={styles.settingsRowLeft}>
                            <Feather
                              name="aperture"
                              size={18}
                              color={autoEnhanceOn ? '#10B981' : '#6B7280'}
                            />
                            <View style={styles.settingsRowText}>
                              <Text style={styles.settingsLabel}>Auto Enhance</Text>
                              <Text style={styles.settingsDesc}>Fast native enhancement</Text>
                            </View>
                          </View>
                          <View style={[styles.toggle, autoEnhanceOn && styles.toggleActive]}>
                            <View
                              style={[styles.toggleKnob, autoEnhanceOn && styles.toggleKnobActive]}
                            />
                          </View>
                        </TouchableOpacity>
                      )}

                      {/* HDR Toggle */}
                      <TouchableOpacity style={styles.settingsRow} onPress={toggleHdr}>
                        <View style={styles.settingsRowLeft}>
                          <Feather name="sun" size={18} color={enableHdr ? '#3B82F6' : '#6B7280'} />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>HDR</Text>
                            <Text style={styles.settingsDesc}>High Dynamic Range</Text>
                          </View>
                        </View>
                        <View style={[styles.toggle, enableHdr && styles.toggleActive]}>
                          <View style={[styles.toggleKnob, enableHdr && styles.toggleKnobActive]} />
                        </View>
                      </TouchableOpacity>

                      {/* Focus Box Toggle */}
                      <TouchableOpacity
                        style={[styles.settingsRow, { borderBottomWidth: 0 }]}
                        onPress={() => setFocusOn(!focusOn)}>
                        <View style={styles.settingsRowLeft}>
                          <Feather
                            name="crosshair"
                            size={18}
                            color={focusOn ? '#10B981' : '#6B7280'}
                          />
                          <View style={styles.settingsRowText}>
                            <Text style={styles.settingsLabel}>Focus Guide</Text>
                            <Text style={styles.settingsDesc}>Show overlay</Text>
                          </View>
                        </View>
                        <View style={[styles.toggle, focusOn && styles.toggleActive]}>
                          <View style={[styles.toggleKnob, focusOn && styles.toggleKnobActive]} />
                        </View>
                      </TouchableOpacity>
                    </ScrollView>
                  </View>
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
    backgroundColor: '#000',
  },
  cameraWrapper: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  debugOverlay: {
    position: 'absolute',
    left: 10,
    right: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  debugText: {
    color: '#fff',
    fontSize: 12,
    lineHeight: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  resolutionModal: {
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingBottom: 14,
    overflow: 'hidden',
  },
  resolutionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  resolutionBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
  },
  resolutionBtnActive: {
    backgroundColor: '#111827',
  },
  resolutionBtnText: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 14,
  },
  resolutionBtnTextActive: {
    color: '#fff',
  },
  resolutionInfo: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  resolutionInfoText: {
    color: '#111827',
    fontWeight: '700',
  },
  resolutionInfoSubText: {
    color: '#6B7280',
    marginTop: 4,
  },
  filterModal: {
    backgroundColor: '#fff',
    borderRadius: 18,
    overflow: 'hidden',
  },
  filterPreview: {
    width: '100%',
    height: 240,
    backgroundColor: '#000',
  },
  filterPreviewEmpty: {
    width: '100%',
    height: 240,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterPreviewEmptyText: {
    color: '#fff',
    fontWeight: '700',
  },
  filterControls: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    maxHeight: 280,
  },
  filterEnableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#F9FAFB',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  filterEnableLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  filterEnableText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  filterSliderSection: {
    marginBottom: 16,
  },
  nativeSlider: {
    width: '100%',
    height: 40,
  },
  filterHint: {
    textAlign: 'center',
    fontSize: 11,
    color: '#9CA3AF',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  filterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  filterLabel: {
    color: '#111827',
    fontWeight: '700',
  },
  filterValue: {
    color: '#6B7280',
    fontWeight: '700',
  },
  sliderTrack: {
    height: 20,
    borderRadius: 10,
    backgroundColor: '#E5E7EB',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#111827',
  },
  sliderKnob: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FCD34D',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.15)',
  },
  filterActions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  filterBtnSecondary: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  filterBtnSecondaryText: {
    color: '#111827',
    fontWeight: '800',
  },
  filterBtnPrimary: {
    flex: 1,
    backgroundColor: '#111827',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  filterBtnPrimaryText: {
    color: '#fff',
    fontWeight: '800',
  },
  // Tap-to-focus indicator
  tapFocusIndicator: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderWidth: 3,
    borderColor: '#FBBF24',
    borderRadius: 8,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
  },
  // Portrait Top Bar
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  // Portrait Bottom Bar - Compact stacked layout
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingHorizontal: 12,
    paddingTop: 10,
    flexDirection: 'column',
    gap: 6,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  bottomBarTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  closeBtnPortrait: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomPresetsInline: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 16,
    padding: 2,
    gap: 2,
  },
  zoomPresetBtnSmall: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: 'transparent',
    minWidth: 36,
    alignItems: 'center',
  },
  zoomPresetBtnActiveSmall: {
    backgroundColor: '#FCD34D',
  },
  zoomPresetTextSmall: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 12,
    fontWeight: '700',
  },
  zoomPresetTextActiveSmall: {
    color: '#000',
  },
  bottomBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  bottomBarControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 2,
  },
  // Lens Selector (0.5x, 1x, 2x)
  lensSelector: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  lensBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  lensBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderColor: '#FCD34D',
  },
  lensBtnText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    fontWeight: 'bold',
  },
  lensBtnTextActive: {
    color: '#000',
  },
  lensSelectorLandscape: {
    flexDirection: 'row',
    justifyContent: 'center',
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
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Landscape Top Bar - Transparent with floating buttons
  topBarLandscape: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  exitBtnLandscape: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  exitBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  landscapeCenterInfo: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  landscapeInfoText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  landscapeTopControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topControlBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 8,
    borderRadius: 8,
  },
  topControlBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.8)',
  },
  topControlBtnText: {
    color: '#fff',
    fontSize: 11,
  },
  // Landscape Thumbnail Wrapper - Add spacing and positioning
  landscapeThumbnailWrapper: {
    marginLeft: 16,
    paddingLeft: 12,
  },
  // Landscape Thumbnail Button - Compact Icon with Count
  landscapeThumbnailButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37, 99, 235, 0.9)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    marginLeft: 8,
  },
  landscapeThumbnailButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  // Legacy styles (kept for compatibility)
  landscapeTopInfo: {
    flex: 1,
    alignItems: 'center',
  },
  lotBadgeLandscape: {
    backgroundColor: 'rgba(37, 99, 235, 0.9)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  statsTextLandscape: {
    color: '#fff',
    fontSize: 10,
    marginTop: 2,
  },
  controlBtnSmall: {
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 10,
  },
  controlBtnActiveSmall: {
    backgroundColor: 'rgba(239, 68, 68, 0.7)',
  },
  // Right Panel (Landscape) - Responsive width with better spacing
  rightPanel: {
    position: 'absolute',
    width: 115,
    paddingHorizontal: 8,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
  },
  rightPanelContent: {
    flex: 1,
    paddingVertical: 8,
    gap: 6,
    justifyContent: 'space-between',
  },
  // Lens styles for landscape
  lensBtnActiveLandscape: {
    backgroundColor: '#EAB308',
  },
  lensBtnTextLandscape: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  lensBtnTextActiveLandscape: {
    color: '#000',
  },
  // Legacy zoom styles (kept for landscape compatibility)
  zoomPresets: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 20,
    padding: 2,
    gap: 2,
  },
  zoomPresetBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'transparent',
    minWidth: 38,
    alignItems: 'center',
  },
  zoomPresetBtnActive: {
    backgroundColor: '#FCD34D',
  },
  zoomPresetText: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 12,
    fontWeight: '700',
  },
  zoomPresetTextActive: {
    color: '#000',
  },
  zoomSliderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 12,
    width: '100%',
    maxWidth: 320,
  },
  zoomLabel: {
    color: '#FCD34D',
    fontSize: 14,
    fontWeight: '700',
    minWidth: 42,
    textAlign: 'center',
  },
  zoomSliderTrack: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
  },
  zoomSliderTrackTouchable: {
    width: '100%',
    height: 32,
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 4,
  },
  zoomSliderFill: {
    position: 'absolute',
    left: 0,
    height: '100%',
    backgroundColor: 'rgba(252, 211, 77, 0.4)',
    borderRadius: 4,
  },
  zoomSliderThumb: {
    position: 'absolute',
    width: 20,
    height: 28,
    borderRadius: 4,
    backgroundColor: '#FCD34D',
    marginLeft: -10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  // Zoom Controls - Landscape (taller row)
  zoomPresetsLandscape: {
    flexDirection: 'row',
    gap: 3,
    marginVertical: 2,
  },
  zoomPresetBtnLandscape: {
    flex: 1,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  zoomPresetBtnActiveLandscape: {
    backgroundColor: '#FCD34D',
    borderColor: '#FCD34D',
  },
  zoomPresetTextLandscape: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  zoomPresetTextActiveLandscape: {
    color: '#000',
  },
  // Capture buttons landscape - Taller buttons to fill space
  captureRowLandscape: {
    flexDirection: 'row',
    gap: 3,
  },
  captureBtnMainLandscape: {
    flex: 1,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(244, 63, 94, 0.9)',
    borderRadius: 8,
    gap: 3,
    paddingHorizontal: 4,
  },
  captureBtnExtraLandscape: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59, 130, 246, 0.9)',
    borderRadius: 8,
  },
  captureBtnTextLandscape: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  // Record button landscape - Taller
  recordBtnLandscape: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(234, 179, 8, 0.9)',
    borderRadius: 8,
  },
  recordBtnActiveLandscape: {
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
  },
  recordBtnDisabledLandscape: {
    opacity: 0.4,
  },
  recordBtnTextLandscape: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  // Action row landscape (settings + enhance) - Night button removed, only 2 buttons
  actionRowLandscape: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  settingsBtnLandscape: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  enhanceBtnLandscape: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  enhanceBtnLandscapeActive: {
    backgroundColor: 'rgba(252, 211, 77, 0.35)',
  },
  // Done button landscape (inline - kept for compatibility)
  doneBtnLandscape: {
    flex: 1,
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(34, 197, 94, 0.85)',
    borderRadius: 8,
    gap: 3,
  },
  doneBtnTextLandscape: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  // Done button landscape - FULL WIDTH taller
  doneBtnLandscapeFull: {
    width: '100%',
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#22C55E',
    borderRadius: 10,
    gap: 6,
    marginTop: 6,
  },
  doneBtnTextLandscapeFull: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  // Thumbnail button inline for landscape
  thumbBtnLandscape: {
    flex: 1,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37, 99, 235, 0.8)',
    borderRadius: 8,
  },
  thumbCountInline: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  lotNavLandscape: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 2,
  },
  lotNavBtnLandscape: {
    flex: 1,
    backgroundColor: 'rgba(37, 99, 235, 0.85)',
    borderRadius: 8,
    paddingVertical: 6,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lotNavBtnLandscapeNext: {
    flex: 1,
    backgroundColor: 'rgba(16, 185, 129, 0.85)',
    borderRadius: 8,
    paddingVertical: 6,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lotNavBtnDisabled: {
    opacity: 0.4,
  },
  lotNavBtnText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
    lineHeight: 12,
  },
  zoomLandscape: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 4,
    marginBottom: 2,
  },
  zoomBtnLandscape: {
    padding: 4,
  },
  zoomLabelLandscape: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
    marginHorizontal: 3,
  },
  thumbsLandscape: {
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  thumbLandscape: {
    width: 44,
    height: 44,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#fff',
  },
  thumbCountLandscape: {
    backgroundColor: '#2563EB',
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    marginTop: 4,
    overflow: 'hidden',
  },
  capturingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Permission Screen
  permissionContainer: {
    flex: 1,
    backgroundColor: '#1F2937',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#fff',
    marginTop: 24,
    marginBottom: 12,
  },
  permissionText: {
    fontSize: 16,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 16,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  cancelButton: {
    padding: 12,
  },
  cancelButtonText: {
    color: '#9CA3AF',
    fontSize: 16,
  },
  // Preview Screen
  previewContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  previewBackBtn: {
    padding: 8,
  },
  previewTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  previewImage: {
    flex: 1,
    width: '100%',
  },
  previewThumbnails: {
    maxHeight: 80,
    backgroundColor: 'rgba(0,0,0,0.8)',
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
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  thumbnailActive: {
    borderColor: '#2563EB',
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  previewActions: {
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  continueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  continueBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  // Settings styles
  settingsBtn: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsBtnPortrait: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  enhanceBtnPortrait: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  enhanceBtnPortraitActive: {
    backgroundColor: 'rgba(252, 211, 77, 0.35)',
    borderColor: '#FCD34D',
  },
  settingsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 200,
  },
  settingsModal: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    width: '90%',
    maxWidth: 320,
    maxHeight: '85%',
  },
  settingsModalLandscape: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    width: '60%',
    maxWidth: 280,
    maxHeight: '90%',
  },
  settingsCloseBtn: {
    padding: 4,
  },
  settingsContent: {
    flexGrow: 0,
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  settingsTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  settingsRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  settingsRowText: {
    marginLeft: 12,
    flex: 1,
  },
  settingsLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
  },
  settingsDesc: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#D1D5DB',
    padding: 2,
    justifyContent: 'center',
  },
  toggleActive: {
    backgroundColor: '#3B82F6',
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleKnobActive: {
    transform: [{ translateX: 20 }],
  },
  settingsInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 16,
    padding: 12,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    gap: 8,
  },
  settingsInfoText: {
    flex: 1,
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 16,
  },
});

export default CameraScreen;
