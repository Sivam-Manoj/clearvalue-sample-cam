export type CaptureMode = 'single_lot' | 'per_item' | 'per_photo';

export interface PhotoFile {
  uri: string;
  displayUri?: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  megapixels?: number;
  focusBox?: { x: number; y: number; w: number; h: number };
  adjustments?: {
    contrast: number;
    saturation: number;
    sharpness: number;
    detail: number;
  };
}

export interface MixedLot {
  id: string;
  mode?: CaptureMode;
  files: PhotoFile[];
  extraFiles: PhotoFile[];
  coverIndex: number;
  videoFile?: PhotoFile;
}

export interface CameraSettings {
  flash: 'off' | 'on' | 'auto';
  zoom: number;
  focusOn: boolean;
  facing: 'front' | 'back';
}

export const MODE_CONFIG = {
  single_lot: {
    label: 'Bundle',
    shortLabel: 'Bundle',
    color: '#F43F5E',
    description: 'All images = 1 lot',
  },
  per_item: {
    label: 'Per Item',
    shortLabel: 'Item',
    color: '#F43F5E',
    description: 'AI identifies items',
  },
  per_photo: {
    label: 'Per Photo',
    shortLabel: 'Photo',
    color: '#F43F5E',
    description: '1 image = 1 item',
  },
} as const;

export const getModeLabel = (mode?: CaptureMode): string => {
  if (!mode) return 'Not Set';
  return MODE_CONFIG[mode].label;
};

export const createNewLot = (): MixedLot => ({
  id: `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  files: [],
  extraFiles: [],
  coverIndex: 0,
});
