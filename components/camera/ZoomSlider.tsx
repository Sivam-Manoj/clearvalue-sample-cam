import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface ZoomSliderProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  isLandscape?: boolean;
}

const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0;
const MAX_ZOOM = 1;

export const ZoomSlider: React.FC<ZoomSliderProps> = ({
  zoom,
  onZoomChange,
  isLandscape = false,
}) => {
  const displayZoom = (1 + zoom * 4).toFixed(1);

  const decreaseZoom = () => {
    onZoomChange(Math.max(MIN_ZOOM, zoom - ZOOM_STEP));
  };

  const increaseZoom = () => {
    onZoomChange(Math.min(MAX_ZOOM, zoom + ZOOM_STEP));
  };

  return (
    <View style={[styles.container, isLandscape && styles.containerLandscape]}>
      <TouchableOpacity onPress={decreaseZoom} style={styles.button}>
        <Feather name="minus" size={18} color="#fff" />
      </TouchableOpacity>
      <Text style={styles.label}>{displayZoom}x</Text>
      <TouchableOpacity onPress={increaseZoom} style={styles.button}>
        <Feather name="plus" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: '45%',
    right: 12,
    flexDirection: 'column',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    padding: 6,
  },
  containerLandscape: {
    top: '35%',
    right: 8,
  },
  button: {
    padding: 10,
  },
  label: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
    marginVertical: 4,
  },
});

export default ZoomSlider;
