import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  Modal,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { MixedLot, CaptureMode } from './CameraCapture';

interface ImageInfo {
  uri: string;
  width: number;
  height: number;
  size: number;
}

export type LotMode = CaptureMode;

interface LotManagerProps {
  lots: MixedLot[];
  setLots: React.Dispatch<React.SetStateAction<MixedLot[]>>;
  activeLotIdx: number;
  setActiveLotIdx: React.Dispatch<React.SetStateAction<number>>;
  onOpenCamera: (lotIdx: number) => void;
  onCreateLot: () => number;
  hideSummary?: boolean; // Hide the internal summary bar (when parent has its own)
}

const MODE_INFO = {
  single_lot: {
    label: 'Bundle',
    desc: 'All images = 1 lot',
    icon: 'package',
    color: '#8B5CF6',
  },
  per_item: {
    label: 'Per Item',
    desc: 'AI identifies items',
    icon: 'grid',
    color: '#2563EB',
  },
  per_photo: {
    label: 'Per Photo',
    desc: '1 image = 1 item',
    icon: 'image',
    color: '#059669',
  },
};

const LotManager = ({
  lots,
  setLots,
  activeLotIdx,
  setActiveLotIdx,
  onOpenCamera,
  onCreateLot,
  hideSummary = false,
}: LotManagerProps) => {
  const [expandedLot, setExpandedLot] = useState<number | null>(
    activeLotIdx >= 0 ? activeLotIdx : null
  );
  const [viewerVisible, setViewerVisible] = useState(false);
  const [selectedImage, setSelectedImage] = useState<ImageInfo | null>(null);
  const [loadingImageInfo, setLoadingImageInfo] = useState(false);
  const [viewerLotIdx, setViewerLotIdx] = useState<number | null>(null);
  const [viewerImgIdx, setViewerImgIdx] = useState(0);

  const activeLot = activeLotIdx >= 0 ? lots[activeLotIdx] : null;
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

  const viewerFiles = useMemo(() => {
    if (viewerLotIdx === null) return [];
    const lot = lots[viewerLotIdx];
    return Array.isArray(lot?.files) ? lot.files : [];
  }, [lots, viewerLotIdx]);

  const resolveViewerUri = useCallback(
    (lotIdx: number, imgIdx: number) => {
      const lot = lots[lotIdx];
      const file = lot?.files?.[imgIdx] as any;
      const uri = (file?.displayUri as string | undefined) ?? (file?.uri as string | undefined);
      return uri;
    },
    [lots]
  );

  const loadImageInfo = useCallback(async (uri: string) => {
    setLoadingImageInfo(true);
    console.log('[LotManager] Loading image info for:', uri?.slice(-50));

    try {
      // Get dimensions using Image.getSize with timeout
      const dimensions = await Promise.race([
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          Image.getSize(
            uri,
            (width, height) => {
              console.log('[LotManager] Image.getSize success:', width, 'x', height);
              resolve({ width, height });
            },
            (error) => {
              console.log('[LotManager] Image.getSize error:', error);
              reject(error);
            }
          );
        }),
        new Promise<{ width: number; height: number }>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000)
        ),
      ]).catch((err) => {
        console.log('[LotManager] Dimensions fetch failed:', err);
        return { width: 0, height: 0 };
      });

      let fileSize = 0;
      // Try multiple URI formats to get file size
      const urisToTry = [
        uri,
        uri.startsWith('file://') ? uri : `file://${uri}`,
        uri.replace('file://', ''),
      ];

      for (const tryUri of urisToTry) {
        try {
          const fileInfo = await FileSystem.getInfoAsync(tryUri);
          console.log('[LotManager] FileSystem.getInfoAsync for', tryUri.slice(-30), ':', fileInfo);
          if (fileInfo.exists && 'size' in fileInfo && fileInfo.size) {
            fileSize = fileInfo.size;
            console.log('[LotManager] Got file size:', fileSize);
            break;
          }
        } catch (e) {
          // Continue to next URI format
        }
      }

      if (fileSize === 0) {
        console.log('[LotManager] Could not get file size for:', uri.slice(-30));
      }

      const result = {
        uri,
        width: dimensions.width,
        height: dimensions.height,
        size: fileSize,
      };
      console.log('[LotManager] Final image info:', result.width, 'x', result.height, 'size:', result.size);
      setSelectedImage(result);
    } catch (error) {
      console.error('[LotManager] Error getting image info:', error);
      setSelectedImage({ uri, width: 0, height: 0, size: 0 });
    } finally {
      setLoadingImageInfo(false);
    }
  }, []);

  const openImageViewer = useCallback(
    async (lotIdx: number, imgIdx: number) => {
      const uri = resolveViewerUri(lotIdx, imgIdx);
      if (!uri) return;
      setViewerLotIdx(lotIdx);
      setViewerImgIdx(imgIdx);
      setViewerVisible(true);
      await loadImageInfo(uri);
    },
    [loadImageInfo, resolveViewerUri]
  );

  const goToViewerImage = useCallback(
    async (nextIdx: number) => {
      if (viewerLotIdx === null) return;
      const total = viewerFiles.length;
      if (total <= 0) return;
      const clamped = Math.max(0, Math.min(nextIdx, total - 1));
      const uri = resolveViewerUri(viewerLotIdx, clamped);
      if (!uri) return;
      setViewerImgIdx(clamped);
      await loadImageInfo(uri);
    },
    [viewerLotIdx, viewerFiles.length, resolveViewerUri, loadImageInfo]
  );

  const closeImageViewer = useCallback(() => {
    setViewerVisible(false);
    setSelectedImage(null);
    setViewerLotIdx(null);
    setViewerImgIdx(0);
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const setLotMode = (idx: number, mode: LotMode) => {
    setLots((prev) => {
      const updated = [...prev];
      const lot = updated[idx];
      if (lot.mode && lot.mode !== mode && lot.files.length > 0) {
        Alert.alert('Warning', 'Cannot change mode after images are added');
        return prev;
      }
      updated[idx] = { ...lot, mode };
      return updated;
    });
  };

  const removeLot = (idx: number) => {
    Alert.alert('Delete Lot', `Are you sure you want to delete Lot ${idx + 1}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setLots((prev) => prev.filter((_, i) => i !== idx));
          if (activeLotIdx >= lots.length - 1) {
            setActiveLotIdx(Math.max(0, lots.length - 2));
          }
          if (expandedLot === idx) {
            setExpandedLot(null);
          }
        },
      },
    ]);
  };

  const removeImage = (lotIdx: number, imgIdx: number) => {
    setLots((prev) => {
      const updated = [...prev];
      const lot = updated[lotIdx];
      const files = lot.files.filter((_, i) => i !== imgIdx);
      const coverIndex = Math.max(0, Math.min(files.length - 1, lot.coverIndex));
      updated[lotIdx] = { ...lot, files, coverIndex };
      return updated;
    });
  };

  const deleteCurrentViewerImage = useCallback(() => {
    if (viewerLotIdx === null) return;
    
    Alert.alert('Delete Image', 'Are you sure you want to delete this image?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const currentIdx = viewerImgIdx;
          const totalFiles = viewerFiles.length;
          
          // Remove the image
          removeImage(viewerLotIdx, currentIdx);
          
          // If this was the last image, close the viewer
          if (totalFiles <= 1) {
            closeImageViewer();
          } else if (currentIdx >= totalFiles - 1) {
            // If we deleted the last image, go to previous
            goToViewerImage(currentIdx - 1);
          } else {
            // Stay at same index (next image will slide in)
            goToViewerImage(currentIdx);
          }
        },
      },
    ]);
  }, [viewerLotIdx, viewerImgIdx, viewerFiles.length, closeImageViewer, goToViewerImage]);

  const setCoverImage = (lotIdx: number, imgIdx: number) => {
    setLots((prev) => {
      const updated = [...prev];
      updated[lotIdx] = { ...updated[lotIdx], coverIndex: imgIdx };
      return updated;
    });
  };

  const pickImages = async (lotIdx: number) => {
    const lot = lots[lotIdx];
    if (!lot.mode) {
      Alert.alert('Select Mode', 'Please select a mode for this lot first');
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (!result.canceled && result.assets.length > 0) {
        const newFiles = result.assets.map((asset, idx) => ({
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}-${idx}.jpg`,
          type: asset.mimeType || 'image/jpeg',
        }));

        setLots((prev) => {
          const updated = [...prev];
          updated[lotIdx] = {
            ...updated[lotIdx],
            files: [...updated[lotIdx].files, ...newFiles],
          };
          return updated;
        });
      }
    } catch (e) {
      console.error('Image picker error:', e);
    }
  };

  const handleOpenCamera = (lotIdx: number) => {
    // Camera now handles lot creation and mode selection internally
    onOpenCamera(lotIdx >= 0 ? lotIdx : 0);
  };

  const openCameraDirectly = () => {
    // Open camera - it will auto-create lot if needed
    onOpenCamera(activeLotIdx >= 0 ? activeLotIdx : 0);
  };

  const renderLotCard = (lot: MixedLot, idx: number) => {
    const isExpanded = expandedLot === idx;
    const isActive = activeLotIdx === idx;
    const modeInfo = lot.mode ? MODE_INFO[lot.mode] : null;

    return (
      <View key={lot.id} style={[styles.lotCard, isActive && styles.lotCardActive]}>
        {/* Lot Header */}
        <TouchableOpacity
          style={styles.lotHeader}
          onPress={() => {
            setExpandedLot(isExpanded ? null : idx);
            setActiveLotIdx(idx);
          }}>
          <View style={styles.lotHeaderLeft}>
            <View style={[styles.lotNumber, isActive && styles.lotNumberActive]}>
              <Text style={[styles.lotNumberText, isActive && styles.lotNumberTextActive]}>
                {idx + 1}
              </Text>
            </View>
            <View>
              <Text style={styles.lotTitle}>Lot {idx + 1}</Text>
              <Text style={styles.lotSubtitle}>
                {lot.files.length} image{lot.files.length !== 1 ? 's' : ''}
                {modeInfo && ` • ${modeInfo.label}`}
              </Text>
            </View>
          </View>
          <View style={styles.lotHeaderRight}>
            <TouchableOpacity onPress={() => removeLot(idx)} style={styles.deleteBtn}>
              <Feather name="trash-2" size={18} color="#EF4444" />
            </TouchableOpacity>
            <Feather name={isExpanded ? 'chevron-up' : 'chevron-down'} size={24} color="#6B7280" />
          </View>
        </TouchableOpacity>

        {/* Expanded Content */}
        {isExpanded && (
          <View style={styles.lotContent}>
            {/* Mode Selection */}
            <Text style={styles.modeLabel}>Select Mode:</Text>
            <View style={styles.modeGrid}>
              {(Object.keys(MODE_INFO) as LotMode[]).map((mode) => {
                const info = MODE_INFO[mode];
                const isSelected = lot.mode === mode;
                return (
                  <TouchableOpacity
                    key={mode}
                    style={[
                      styles.modeBtn,
                      isSelected && { backgroundColor: info.color + '20', borderColor: info.color },
                    ]}
                    onPress={() => setLotMode(idx, mode)}>
                    <Feather
                      name={info.icon as any}
                      size={20}
                      color={isSelected ? info.color : '#6B7280'}
                    />
                    <Text style={[styles.modeBtnLabel, isSelected && { color: info.color }]}>
                      {info.label}
                    </Text>
                    <Text style={styles.modeBtnDesc}>{info.desc}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Image Actions */}
            <View style={styles.imageActions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.cameraBtn]}
                onPress={() => handleOpenCamera(idx)}>
                <Feather name="camera" size={20} color="#fff" />
                <Text style={styles.actionBtnText}>Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.galleryBtn]}
                onPress={() => pickImages(idx)}>
                <Feather name="image" size={20} color="#fff" />
                <Text style={styles.actionBtnText}>Gallery</Text>
              </TouchableOpacity>
            </View>

            {/* Image Grid */}
            {lot.files.length > 0 && (
              <View style={styles.imageGrid}>
                {lot.files.map((file, imgIdx) => (
                  <TouchableOpacity 
                    key={`${lot.id}-${imgIdx}`} 
                    style={styles.imageItem}
                    onPress={() => openImageViewer(idx, imgIdx)}
                    activeOpacity={0.8}>
                    <Image source={{ uri: file.uri }} style={styles.imageThumb} />
                    {lot.coverIndex === imgIdx && (
                      <View style={styles.coverBadge}>
                        <Feather name="star" size={12} color="#fff" />
                      </View>
                    )}
                    <View style={styles.imageOverlay}>
                      <TouchableOpacity
                        style={styles.imageBtn}
                        onPress={(e) => {
                          e.stopPropagation();
                          setCoverImage(idx, imgIdx);
                        }}>
                        <Feather name="star" size={14} color="#fff" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.imageBtn, styles.imageBtnDelete]}
                        onPress={(e) => {
                          e.stopPropagation();
                          removeImage(idx, imgIdx);
                        }}>
                        <Feather name="x" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Empty State */}
            {lot.files.length === 0 && lot.mode && (
              <View style={styles.emptyState}>
                <Feather name="image" size={40} color="#D1D5DB" />
                <Text style={styles.emptyText}>No images yet</Text>
                <Text style={styles.emptySubtext}>Use Camera or Gallery to add images</Text>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Open Camera Button - Main Action */}
      <TouchableOpacity style={styles.openCameraBtn} onPress={openCameraDirectly}>
        <Feather name="camera" size={24} color="#fff" />
        <Text style={styles.openCameraBtnText}>Open Camera</Text>
        <Text style={styles.openCameraBtnSubtext}>Capture photos for all lots</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Image Lots</Text>
        <TouchableOpacity
          style={styles.addLotBtn}
          onPress={() => {
            const newIdx = onCreateLot();
            setExpandedLot(newIdx);
          }}>
          <Feather name="plus" size={20} color="#fff" />
          <Text style={styles.addLotBtnText}>Add Lot</Text>
        </TouchableOpacity>
      </View>

      {/* Lots List */}
      <ScrollView
        style={styles.lotsList}
        contentContainerStyle={styles.lotsListContent}
        showsVerticalScrollIndicator={false}>
        {lots.length === 0 ? (
          <View style={styles.noLotsState}>
            <Feather name="layers" size={48} color="#D1D5DB" />
            <Text style={styles.noLotsTitle}>No Lots Yet</Text>
            <Text style={styles.noLotsText}>
              Create a lot to start adding images for your appraisal
            </Text>
            <TouchableOpacity
              style={styles.createFirstBtn}
              onPress={() => {
                const newIdx = onCreateLot();
                setExpandedLot(newIdx);
              }}>
              <Feather name="plus" size={20} color="#fff" />
              <Text style={styles.createFirstBtnText}>Create First Lot</Text>
            </TouchableOpacity>
          </View>
        ) : (
          lots.map((lot, idx) => renderLotCard(lot, idx))
        )}
      </ScrollView>

      {/* Summary */}
      {lots.length > 0 && !hideSummary && (
        <View style={styles.summary}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{lots.length}</Text>
            <Text style={styles.summaryLabel}>Lots</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>
              {lots.reduce((sum, lot) => sum + lot.files.length, 0)}
            </Text>
            <Text style={styles.summaryLabel}>Images</Text>
          </View>
        </View>
      )}

      {/* Full-Screen Image Viewer Modal */}
      <Modal
        visible={viewerVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={closeImageViewer}
        statusBarTranslucent>
        <TouchableOpacity 
          style={styles.viewerContainer} 
          activeOpacity={1}
          onPress={closeImageViewer}>
          {/* Top Bar with Close and Delete */}
          <View style={styles.viewerTopBar}>
            <TouchableOpacity 
              style={styles.viewerCloseBtn} 
              onPress={closeImageViewer}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="x" size={24} color="#fff" />
            </TouchableOpacity>
            
            {viewerLotIdx !== null && viewerFiles.length > 0 && (
              <View style={styles.viewerCounter}>
                <Text style={styles.viewerCounterText}>
                  {viewerImgIdx + 1}/{viewerFiles.length}
                </Text>
              </View>
            )}
            
            <TouchableOpacity 
              style={styles.viewerDeleteBtn} 
              onPress={deleteCurrentViewerImage}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="trash-2" size={22} color="#EF4444" />
            </TouchableOpacity>
          </View>

          {/* Image */}
          {selectedImage && (
            <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()}>
              <Image
                source={{ uri: selectedImage.uri }}
                style={styles.viewerImage}
                resizeMode="contain"
              />
            </TouchableOpacity>
          )}

          {viewerLotIdx !== null && viewerFiles.length > 1 && (
            <>
              <TouchableOpacity
                style={[
                  styles.viewerNavBtn,
                  styles.viewerNavLeft,
                  viewerImgIdx <= 0 && styles.viewerNavBtnDisabled,
                ]}
                disabled={viewerImgIdx <= 0}
                onPress={(e) => {
                  e.stopPropagation();
                  goToViewerImage(viewerImgIdx - 1);
                }}>
                <Feather name="chevron-left" size={28} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.viewerNavBtn,
                  styles.viewerNavRight,
                  viewerImgIdx >= viewerFiles.length - 1 && styles.viewerNavBtnDisabled,
                ]}
                disabled={viewerImgIdx >= viewerFiles.length - 1}
                onPress={(e) => {
                  e.stopPropagation();
                  goToViewerImage(viewerImgIdx + 1);
                }}>
                <Feather name="chevron-right" size={28} color="#fff" />
              </TouchableOpacity>
            </>
          )}

          {/* Loading indicator */}
          {loadingImageInfo && (
            <View style={styles.viewerLoading}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          )}

          {/* Image Info Footer */}
          {selectedImage && !loadingImageInfo && (
            <TouchableOpacity 
              style={styles.viewerInfoBar} 
              activeOpacity={1} 
              onPress={(e) => e.stopPropagation()}>
              <View style={styles.viewerInfoItem}>
                <Feather name="maximize-2" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.viewerInfoLabel}>Resolution</Text>
                <Text style={styles.viewerInfoValue}>
                  {selectedImage.width > 0 
                    ? `${selectedImage.width} × ${selectedImage.height}` 
                    : 'Loading...'}
                </Text>
              </View>
              <View style={styles.viewerInfoDivider} />
              <View style={styles.viewerInfoItem}>
                <Feather name="hard-drive" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.viewerInfoLabel}>Size</Text>
                <Text style={styles.viewerInfoValue}>
                  {selectedImage.size > 0 ? formatFileSize(selectedImage.size) : 'Loading...'}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  openCameraBtn: {
    backgroundColor: '#F43F5E',
    margin: 12,
    marginBottom: 0,
    padding: 14,
    borderRadius: 18,
    alignItems: 'center',
    shadowColor: '#F43F5E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  openCameraBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 4,
    letterSpacing: -0.3,
  },
  openCameraBtnSubtext: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#1F2937',
    letterSpacing: -0.3,
  },
  addLotBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563EB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  addLotBtnText: {
    color: '#fff',
    fontWeight: '700',
    marginLeft: 6,
    fontSize: 13,
  },
  lotsList: {
    flex: 1,
  },
  lotsListContent: {
    padding: 16,
    paddingBottom: 100,
  },
  lotCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    marginBottom: 10,
    borderWidth: 2,
    borderColor: 'rgba(0, 0, 0, 0.04)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  lotCardActive: {
    borderColor: '#2563EB',
    shadowColor: '#2563EB',
    shadowOpacity: 0.2,
  },
  lotHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    minHeight: 72,
  },
  lotHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lotNumber: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
    borderWidth: 2,
    borderColor: '#E5E7EB',
  },
  lotNumberActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  lotNumberText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#6B7280',
  },
  lotNumberTextActive: {
    color: '#fff',
  },
  lotTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1F2937',
    letterSpacing: -0.3,
  },
  lotSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 3,
    fontWeight: '500',
  },
  lotHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  deleteBtn: {
    padding: 8,
    marginRight: 4,
  },
  lotContent: {
    padding: 14,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  modeLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 10,
    marginTop: 8,
  },
  modeGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  modeBtn: {
    flex: 1,
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  modeBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    marginTop: 4,
  },
  modeBtnDesc: {
    fontSize: 9,
    color: '#9CA3AF',
    marginTop: 1,
    textAlign: 'center',
    fontWeight: '500',
  },
  imageActions: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  cameraBtn: {
    backgroundColor: '#2563EB',
    shadowColor: '#2563EB',
  },
  galleryBtn: {
    backgroundColor: '#8B5CF6',
    shadowColor: '#8B5CF6',
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: '600',
    marginLeft: 8,
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 16,
    gap: 8,
  },
  imageItem: {
    width: '31%',
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  imageThumb: {
    width: '100%',
    height: '100%',
  },
  coverBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: '#F59E0B',
    borderRadius: 10,
    padding: 4,
  },
  imageOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 4,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  imageBtn: {
    padding: 4,
  },
  imageBtnDelete: {
    backgroundColor: 'rgba(239, 68, 68, 0.8)',
    borderRadius: 4,
  },
  emptyState: {
    alignItems: 'center',
    padding: 24,
    marginTop: 8,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6B7280',
    marginTop: 12,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#9CA3AF',
    marginTop: 4,
  },
  noLotsState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    marginTop: 60,
  },
  noLotsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#374151',
    marginTop: 16,
  },
  noLotsText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 24,
  },
  createFirstBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  createFirstBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    marginLeft: 8,
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
  },
  summaryItem: {
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  summaryValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#2563EB',
  },
  summaryLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#E5E7EB',
  },
  // Full-Screen Image Viewer
  viewerContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerTopBar: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 20,
  },
  viewerCloseBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerDeleteBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerNavBtn: {
    position: 'absolute',
    top: '50%',
    width: 50,
    height: 50,
    borderRadius: 25,
    marginTop: -25,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  viewerNavLeft: {
    left: 16,
  },
  viewerNavRight: {
    right: 16,
  },
  viewerNavBtnDisabled: {
    opacity: 0.35,
  },
  viewerCounter: {
    alignItems: 'center',
  },
  viewerCounterText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  viewerImage: {
    width: '100%',
    height: '70%',
  },
  viewerLoading: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerInfoBar: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 16,
    padding: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerInfoItem: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  viewerInfoLabel: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.6)',
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  viewerInfoValue: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '700',
  },
  viewerInfoDivider: {
    width: 1,
    height: 36,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    marginHorizontal: 16,
  },
});

export default LotManager;
