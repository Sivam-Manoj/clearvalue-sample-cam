import React from 'react';
import { Text, TouchableOpacity, StyleSheet, Vibration } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface RecordButtonProps {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  disabled?: boolean;
  isLandscape?: boolean;
  compact?: boolean;
}

export const RecordButton: React.FC<RecordButtonProps> = ({
  isRecording,
  onStartRecording,
  onStopRecording,
  disabled = false,
  isLandscape = false,
  compact = false,
}) => {
  const handlePress = () => {
    Vibration.vibrate(100);
    if (isRecording) {
      onStopRecording();
    } else {
      onStartRecording();
    }
  };

  return (
    <TouchableOpacity
      style={[
        styles.recordBtn,
        isRecording && styles.recordBtnActive,
        isLandscape && styles.recordBtnLandscape,
        compact && styles.recordBtnCompact,
        disabled && styles.recordBtnDisabled,
      ]}
      onPress={handlePress}
      disabled={disabled}>
      <Feather name={isRecording ? 'square' : 'video'} size={compact ? 18 : 20} color="#fff" />
      <Text style={[styles.recordBtnText, compact && styles.recordBtnTextCompact]}>
        {isRecording ? 'Stop' : compact ? 'Rec' : 'Record'}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  recordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(234, 179, 8, 0.9)',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    alignSelf: 'center',
    gap: 8,
  },
  recordBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
  },
  recordBtnLandscape: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  recordBtnCompact: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 18,
    alignSelf: 'auto',
    gap: 6,
  },
  recordBtnDisabled: {
    opacity: 0.5,
  },
  recordBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  recordBtnTextCompact: {
    fontSize: 11,
  },
});

export default RecordButton;
