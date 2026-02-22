import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { PhotoFile } from './types';

interface PhotoThumbnailsProps {
  photos: PhotoFile[];
  onPress: () => void;
  isLandscape?: boolean;
  compact?: boolean;
}

export const PhotoThumbnails: React.FC<PhotoThumbnailsProps> = ({
  photos,
  onPress,
  isLandscape = false,
  compact = false,
}) => {
  if (photos.length === 0) return null;

  const displayPhotos = photos.slice(-3);

  return (
    <TouchableOpacity
      style={[
        styles.container,
        isLandscape && styles.containerLandscape,
        compact && styles.containerCompact,
      ]}
      onPress={onPress}>
      <View style={styles.stack}>
        {displayPhotos.map((photo, idx) => (
          <Image
            key={idx}
            source={{ uri: photo.displayUri ?? photo.uri }}
            style={[
              styles.thumb,
              {
                right: idx * 6,
                zIndex: 3 - idx,
                opacity: 1 - idx * 0.15,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.count}>
        <Text style={styles.countText}>{photos.length}</Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  containerLandscape: {
    marginBottom: 8,
  },
  containerCompact: {
    marginBottom: 0,
  },
  stack: {
    width: 52,
    height: 52,
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
  },
  count: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 12,
  },
  countText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
});

export default PhotoThumbnails;
