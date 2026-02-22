import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

type FlashMode = 'off' | 'on' | 'auto';

interface TopControlsProps {
  flash: FlashMode;
  focusOn: boolean;
  onFlashToggle: () => void;
  onFocusToggle: () => void;
  onDone: () => void;
  isLandscape?: boolean;
  compact?: boolean;
}

const FLASH_ICONS: Record<FlashMode, string> = {
  on: 'zap',
  auto: 'zap',
  off: 'zap-off',
};

const FLASH_LABELS: Record<FlashMode, string> = {
  on: 'ON',
  auto: 'AUTO',
  off: 'OFF',
};

export const TopControls: React.FC<TopControlsProps> = ({
  flash,
  focusOn,
  onFlashToggle,
  onFocusToggle,
  onDone,
  isLandscape = false,
  compact = false,
}) => {
  return (
    <View style={[styles.rightControls, compact && styles.rightControlsCompact]}>
      <TouchableOpacity onPress={onFlashToggle} style={[styles.controlBtn, compact && styles.controlBtnCompact]}>
        <Feather
          name={FLASH_ICONS[flash] as any}
          size={compact ? 18 : 22}
          color={flash === 'on' ? '#FCD34D' : '#fff'}
        />
        <Text style={[styles.controlLabel, compact && styles.controlLabelCompact]}>
          {FLASH_LABELS[flash]}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onFocusToggle}
        style={[
          styles.controlBtn,
          compact && styles.controlBtnCompact,
          focusOn && styles.controlBtnActive,
        ]}>
        <Feather name="crosshair" size={compact ? 18 : 22} color={focusOn ? '#fff' : '#fff'} />
        <Text
          style={[
            styles.controlLabel,
            compact && styles.controlLabelCompact,
            focusOn && styles.controlLabelActive,
          ]}>
          Focus
        </Text>
      </TouchableOpacity>
    </View>
  );
};

interface DoneButtonProps {
  onDone: () => void;
  compact?: boolean;
}

export const DoneButton: React.FC<DoneButtonProps> = ({ onDone, compact = false }) => {
  return (
    <TouchableOpacity onPress={onDone} style={[styles.doneBtn, compact && styles.doneBtnCompact]}>
      <Feather name="check" size={compact ? 20 : 24} color="#10B981" />
      <Text style={[styles.doneBtnLabel, compact && styles.doneBtnLabelCompact]}>Done</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  rightControls: {
    flexDirection: 'row',
    gap: 8,
  },
  rightControlsCompact: {
    gap: 6,
  },
  controlBtn: {
    padding: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 12,
    minWidth: 54,
  },
  controlBtnCompact: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    minWidth: 46,
  },
  controlBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.7)',
  },
  controlLabel: {
    color: '#fff',
    fontSize: 10,
    marginTop: 2,
  },
  controlLabelCompact: {
    fontSize: 9,
    marginTop: 1,
  },
  controlLabelActive: {
    fontWeight: 'bold',
  },
  doneBtn: {
    padding: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 12,
    minWidth: 54,
  },
  doneBtnCompact: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    minWidth: 46,
  },
  doneBtnLabel: {
    color: '#10B981',
    fontSize: 10,
    marginTop: 2,
    fontWeight: 'bold',
  },
  doneBtnLabelCompact: {
    fontSize: 9,
    marginTop: 1,
  },
});

export default TopControls;
