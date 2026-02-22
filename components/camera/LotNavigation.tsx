import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Vibration } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { MixedLot, getModeLabel } from './types';

interface LotNavigationProps {
  lots: MixedLot[];
  activeLotIdx: number;
  onPrevLot: () => void;
  onNextLot: () => void;
  isLandscape?: boolean;
  compact?: boolean;
}

export const LotNavigation: React.FC<LotNavigationProps> = ({
  lots,
  activeLotIdx,
  onPrevLot,
  onNextLot,
  isLandscape = false,
  compact = false,
}) => {
  const currentLot = lots[activeLotIdx];
  const mainCount = currentLot?.files?.length ?? 0;
  const extraCount = currentLot?.extraFiles?.length ?? 0;
  const hasVideo = !!currentLot?.videoFile;
  const totalImages = lots.reduce(
    (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
    0
  );

  const handlePrev = () => {
    if (activeLotIdx > 0) {
      Vibration.vibrate(30);
      onPrevLot();
    }
  };

  const handleNext = () => {
    Vibration.vibrate(30);
    onNextLot();
  };

  return (
    <View
      style={[
        styles.container,
        isLandscape && styles.containerLandscape,
        compact && styles.containerCompact,
      ]}>
      <View style={[styles.navRow, compact && styles.navRowCompact]}>
        <TouchableOpacity
          onPress={handlePrev}
          disabled={activeLotIdx <= 0}
          style={[
            styles.navBtn,
            compact && styles.navBtnCompact,
            activeLotIdx <= 0 && styles.navBtnDisabled,
          ]}>
          <Feather name="chevron-left" size={compact ? 20 : 22} color="#fff" />
        </TouchableOpacity>

        <View style={[styles.lotInfo, compact && styles.lotInfoCompact]}>
          <Text style={[styles.lotBadge, compact && styles.lotBadgeCompact]}>
            Lot {activeLotIdx + 1}
          </Text>
          <Text style={[styles.modeText, compact && styles.modeTextCompact]}>
            {getModeLabel(currentLot?.mode)}
          </Text>
        </View>

        <TouchableOpacity onPress={handleNext} style={[styles.navBtn, compact && styles.navBtnCompact]}>
          <Feather name="chevron-right" size={compact ? 20 : 22} color="#fff" />
        </TouchableOpacity>
      </View>

      <Text style={[styles.statsText, compact && styles.statsTextCompact]}>
        Main: {mainCount} | Extra: {extraCount} | Total: {totalImages}
        {hasVideo && ' | 🎥'}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    paddingHorizontal: 8,
  },
  containerLandscape: {
    paddingHorizontal: 4,
  },
  containerCompact: {
    paddingHorizontal: 4,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  navRowCompact: {
    gap: 4,
  },
  navBtn: {
    backgroundColor: 'rgba(37, 99, 235, 0.85)',
    borderRadius: 18,
    padding: 8,
  },
  navBtnCompact: {
    borderRadius: 14,
    padding: 6,
  },
  navBtnDisabled: {
    opacity: 0.4,
  },
  lotInfo: {
    alignItems: 'center',
    minWidth: 90,
  },
  lotInfoCompact: {
    minWidth: 80,
  },
  lotBadge: {
    backgroundColor: 'rgba(37, 99, 235, 0.9)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 18,
    overflow: 'hidden',
  },
  lotBadgeCompact: {
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 16,
  },
  modeText: {
    color: '#FCD34D',
    fontSize: 11,
    marginTop: 3,
    fontWeight: '600',
  },
  modeTextCompact: {
    fontSize: 10,
    marginTop: 2,
  },
  statsText: {
    color: '#fff',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  statsTextCompact: {
    fontSize: 10,
    marginTop: 2,
  },
});

export default LotNavigation;
