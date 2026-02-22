import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
  PanResponder,
  TouchableOpacity,
  Text,
  Animated,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { Feather } from '@expo/vector-icons';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface FocusBoxProps {
  visible: boolean;
  isLandscape?: boolean;
  viewWidth?: number;
  viewHeight?: number;
  onBoxChange?: (rect: { x: number; y: number; width: number; height: number }) => void;
}

const MIN_SIZE = 80;
const MAX_SIZE_RATIO = 0.9;

export const FocusBox: React.FC<FocusBoxProps> = ({
  visible,
  isLandscape = false,
  viewWidth,
  viewHeight,
  onBoxChange,
}) => {
  const { width: winWidth, height: winHeight } = Dimensions.get('window');
  const screenWidth = Number.isFinite(viewWidth) && (viewWidth || 0) > 0 ? (viewWidth as number) : winWidth;
  const screenHeight = Number.isFinite(viewHeight) && (viewHeight || 0) > 0 ? (viewHeight as number) : winHeight;

  // Default size based on orientation
  const defaultWidth = isLandscape ? screenWidth * 0.4 : screenWidth * 0.55;
  const defaultHeight = isLandscape ? screenHeight * 0.55 : screenHeight * 0.3;

  // Use Animated.ValueXY for smooth position
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  
  // State for size (using state for resize since it needs re-render)
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Refs to track gesture state
  const lastPan = useRef({ x: 0, y: 0 });
  const lastSize = useRef({ width: defaultWidth, height: defaultHeight });

  const emitBoxChange = useCallback(() => {
    if (!onBoxChange) return;
    const x = screenWidth / 2 - size.width / 2 + lastPan.current.x;
    const y = screenHeight / 2 - size.height / 2 + lastPan.current.y;
    const clampedX = Math.max(0, Math.min(x, Math.max(0, screenWidth - size.width)));
    const clampedY = Math.max(0, Math.min(y, Math.max(0, screenHeight - size.height)));
    onBoxChange({ x: clampedX, y: clampedY, width: size.width, height: size.height });
  }, [onBoxChange, screenHeight, screenWidth, size.height, size.width]);

  useEffect(() => {
    emitBoxChange();
  }, [emitBoxChange, visible]);

  // Update defaults when orientation changes
  useEffect(() => {
    const newWidth = isLandscape ? screenWidth * 0.4 : screenWidth * 0.55;
    const newHeight = isLandscape ? screenHeight * 0.55 : screenHeight * 0.3;
    setSize({ width: newWidth, height: newHeight });
    lastSize.current = { width: newWidth, height: newHeight };
    pan.setValue({ x: 0, y: 0 });
    lastPan.current = { x: 0, y: 0 };
  }, [isLandscape, screenWidth, screenHeight]);

  // Clamp position to screen bounds
  const clampPosition = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const maxX = (screenWidth - w) / 2;
      const maxY = (screenHeight - h) / 2;
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    [screenWidth, screenHeight]
  );

  // Main drag PanResponder - for moving the entire box
  const dragResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 2 || Math.abs(gs.dy) > 2,
      onPanResponderGrant: () => {
        pan.setOffset({ x: lastPan.current.x, y: lastPan.current.y });
        pan.setValue({ x: 0, y: 0 });
        setIsDragging(true);
      },
      onPanResponderMove: (_, gs) => {
        const clamped = clampPosition(
          lastPan.current.x + gs.dx,
          lastPan.current.y + gs.dy,
          size.width,
          size.height
        );
        pan.setValue({
          x: clamped.x - lastPan.current.x,
          y: clamped.y - lastPan.current.y,
        });
      },
      onPanResponderRelease: (_, gs) => {
        pan.flattenOffset();
        const clamped = clampPosition(
          lastPan.current.x + gs.dx,
          lastPan.current.y + gs.dy,
          size.width,
          size.height
        );
        lastPan.current = clamped;
        pan.setValue(clamped);
        emitBoxChange();
        setIsDragging(false);
      },
    })
  ).current;

  // Helper to calculate new size from gesture
  const calcNewSize = useCallback(
    (corner: 'tl' | 'tr' | 'bl' | 'br', dx: number, dy: number, startSize: { width: number; height: number }) => {
      let dw = 0;
      let dh = 0;

      if (corner === 'br') {
        dw = dx * 2;
        dh = dy * 2;
      } else if (corner === 'bl') {
        dw = -dx * 2;
        dh = dy * 2;
      } else if (corner === 'tr') {
        dw = dx * 2;
        dh = -dy * 2;
      } else if (corner === 'tl') {
        dw = -dx * 2;
        dh = -dy * 2;
      }

      return {
        width: Math.max(MIN_SIZE, Math.min(screenWidth * MAX_SIZE_RATIO, startSize.width + dw)),
        height: Math.max(MIN_SIZE, Math.min(screenHeight * MAX_SIZE_RATIO, startSize.height + dh)),
      };
    },
    [screenWidth, screenHeight]
  );

  // Create resize responder for a corner - uses ref to track start size
  const createResizeResponder = useCallback(
    (corner: 'tl' | 'tr' | 'bl' | 'br') => {
      const startSizeRef = { width: 0, height: 0 };
      
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          // Capture current size at gesture start
          startSizeRef.width = lastSize.current.width;
          startSizeRef.height = lastSize.current.height;
        },
        onPanResponderMove: (_, gs) => {
          const newSize = calcNewSize(corner, gs.dx, gs.dy, startSizeRef);
          setSize(newSize);
        },
        onPanResponderRelease: (_, gs) => {
          // Calculate final size from gesture and update lastSize
          const finalSize = calcNewSize(corner, gs.dx, gs.dy, startSizeRef);
          lastSize.current = finalSize;
          setSize(finalSize);
          emitBoxChange();
        },
      });
    },
    [calcNewSize, emitBoxChange]
  );

  // Create resize responders once
  const resizeTL = useRef(createResizeResponder('tl'));
  const resizeTR = useRef(createResizeResponder('tr'));
  const resizeBL = useRef(createResizeResponder('bl'));
  const resizeBR = useRef(createResizeResponder('br'));

  // Recreate resize responders when calcNewSize changes (screen size changes)
  useEffect(() => {
    resizeTL.current = createResizeResponder('tl');
    resizeTR.current = createResizeResponder('tr');
    resizeBL.current = createResizeResponder('bl');
    resizeBR.current = createResizeResponder('br');
  }, [createResizeResponder]);

  const toggleMinimize = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsMinimized((prev) => !prev);
  }, []);

  const resetBox = useCallback(() => {
    Animated.spring(pan, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: false,
      friction: 7,
      tension: 40,
    }).start();
    lastPan.current = { x: 0, y: 0 };
    
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSize({ width: defaultWidth, height: defaultHeight });
    lastSize.current = { width: defaultWidth, height: defaultHeight };
  }, [defaultWidth, defaultHeight, pan]);

  if (!visible) return null;

  // Minimized state
  if (isMinimized) {
    return (
      <View
        style={[styles.minimizedContainer, isLandscape && styles.minimizedContainerLandscape]}
        pointerEvents="box-none">
        <TouchableOpacity style={styles.minimizedButton} onPress={toggleMinimize}>
          <Feather name="maximize-2" size={16} color="#EF4444" />
          <Text style={styles.minimizedText}>Focus</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Calculate box center position for corner placement
  const boxCenterX = screenWidth / 2;
  const boxCenterY = screenHeight / 2;

  return (
    <View style={styles.container} pointerEvents="box-none">
      {/* Main focus box - draggable */}
      <Animated.View
        style={[
          styles.focusBox,
          {
            width: size.width,
            height: size.height,
            transform: pan.getTranslateTransform(),
            opacity: isDragging ? 0.9 : 1,
          },
        ]}
        {...dragResponder.panHandlers}>
        {/* Center move indicator */}
        <View style={styles.dragIndicator}>
          <Feather name="move" size={20} color="rgba(239,68,68,0.7)" />
        </View>

        {/* Control buttons */}
        <View style={styles.controlButtons}>
          <TouchableOpacity style={styles.controlBtn} onPress={toggleMinimize} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="minimize-2" size={14} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.controlBtn} onPress={resetBox} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="refresh-cw" size={14} color="#fff" />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Resize corners - OUTSIDE the main box so they can capture gestures */}
      <Animated.View
        style={[
          styles.corner,
          {
            left: boxCenterX - size.width / 2 - 22,
            top: boxCenterY - size.height / 2 - 22,
            transform: pan.getTranslateTransform(),
          },
        ]}
        {...resizeTL.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        style={[
          styles.corner,
          {
            left: boxCenterX + size.width / 2 - 22,
            top: boxCenterY - size.height / 2 - 22,
            transform: pan.getTranslateTransform(),
          },
        ]}
        {...resizeTR.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        style={[
          styles.corner,
          {
            left: boxCenterX - size.width / 2 - 22,
            top: boxCenterY + size.height / 2 - 22,
            transform: pan.getTranslateTransform(),
          },
        ]}
        {...resizeBL.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        style={[
          styles.corner,
          {
            left: boxCenterX + size.width / 2 - 22,
            top: boxCenterY + size.height / 2 - 22,
            transform: pan.getTranslateTransform(),
          },
        ]}
        {...resizeBR.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  minimizedContainer: {
    position: 'absolute',
    top: 100,
    right: 10,
  },
  minimizedContainerLandscape: {
    top: 50,
    right: 120,
  },
  minimizedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#EF4444',
    gap: 4,
  },
  minimizedText: {
    color: '#EF4444',
    fontSize: 11,
    fontWeight: '600',
  },
  focusBox: {
    borderWidth: 2.5,
    borderColor: '#EF4444',
    borderRadius: 4,
    backgroundColor: 'transparent',
  },
  dragIndicator: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -12,
    marginLeft: -12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.6,
  },
  moveHandle: {
    position: 'absolute',
    top: -28,
    left: '50%',
    marginLeft: -20,
    width: 40,
    height: 24,
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlButtons: {
    position: 'absolute',
    top: -28,
    right: 0,
    flexDirection: 'row',
    gap: 4,
  },
  controlBtn: {
    width: 28,
    height: 28,
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  cornerInner: {
    width: 20,
    height: 20,
    borderColor: '#EF4444',
    borderWidth: 3,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 4,
  },
});

export default FocusBox;
