import AsyncStorage from '@react-native-async-storage/async-storage';

const FILTER_SETTINGS_KEY = '@camera_filter_settings';

export interface FilterSettings {
  contrast: number;
  saturation: number;
  sharpness: number;
  detail: number;
  enabled: boolean;
}

export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  contrast: 1,
  saturation: 1,
  sharpness: 0,
  detail: 0,
  enabled: false,
};

export const loadFilterSettings = async (): Promise<FilterSettings> => {
  try {
    const stored = await AsyncStorage.getItem(FILTER_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_FILTER_SETTINGS, ...parsed };
    }
  } catch (error) {
    console.warn('[FilterSettings] Failed to load:', error);
  }
  return DEFAULT_FILTER_SETTINGS;
};

export const saveFilterSettings = async (settings: FilterSettings): Promise<void> => {
  try {
    await AsyncStorage.setItem(FILTER_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('[FilterSettings] Failed to save:', error);
  }
};

export const resetFilterSettings = async (): Promise<FilterSettings> => {
  try {
    await AsyncStorage.setItem(FILTER_SETTINGS_KEY, JSON.stringify(DEFAULT_FILTER_SETTINGS));
  } catch (error) {
    console.warn('[FilterSettings] Failed to reset:', error);
  }
  return DEFAULT_FILTER_SETTINGS;
};
