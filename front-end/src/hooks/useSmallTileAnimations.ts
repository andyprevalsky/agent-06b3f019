/**
 * Hook for managing small tile animations
 * 
 * This hook manages:
 * - Which tiles are currently animating
 * - Random selection of tiles (from tileColors) to animate every second
 * - Animation state and timing
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  TilePosition,
  AnimatingTile,
} from '@/lib/smallTileAnimations';

interface UseSmallTileAnimationsOptions {
  enabled: boolean; // Whether animations are enabled
  viewportWidth: number;
  viewportHeight: number;
  tileSize: number;
  largeTileSize: number;
  everColoredTiles: Set<string>; // Tiles that have EVER had colors > 0
  animationInterval?: number; // Time between triggering new animations (ms)
  selectedAgentId?: string | null; // If an agent is selected, don't refill animations
}

export function useSmallTileAnimations({
  enabled,
  viewportWidth,
  viewportHeight,
  tileSize,
  largeTileSize,
  everColoredTiles,
  animationInterval = 800, // Default: 0.8 seconds
  selectedAgentId = null,
}: UseSmallTileAnimationsOptions) {
  const [animatingTiles, setAnimatingTiles] = useState<AnimatingTile[]>([]);
  const [delayPassed, setDelayPassed] = useState<boolean>(false);
  const animationFrameRef = useRef<number | null>(null);
  const lastTriggerTimeRef = useRef<number>(0);
  const currentAnimationIndexRef = useRef<number>(0);
  const hasStartedRef = useRef<boolean>(false);
  const hasReachedMaxRef = useRef<boolean>(false);
  const isRefillingRef = useRef<boolean>(false);
  const enabledTimeRef = useRef<number | null>(null);

  // Available animations to cycle through: animation-1, animation-2, animation-3, animation-4
  const availableAnimations = ['animation-1', 'animation-2', 'animation-3', 'animation-4'];
  const MAX_CONCURRENT_ANIMATIONS = 4; // Changed from 5 to 4
  const START_DELAY_MS = 800; // 0.8 second delay after enabled

  // Helper function to assign tiles to groups based on proximity to large tile center
  const getGroupId = useCallback((row: number, col: number): string => {
    // Calculate the center of the large tile in grid coordinates
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight * 0.4;
    const largeTileHalf = largeTileSize / 2;
    const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
    const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
    const gridOriginX = centerX - largeTileHalf - (tilesLeft * tileSize);
    const gridOriginY = centerY - largeTileHalf - (tilesUp * tileSize);
    
    // Find the center tile's row/col
    const centerTileRow = Math.floor((centerY - gridOriginY) / tileSize);
    const centerTileCol = Math.floor((centerX - gridOriginX) / tileSize);
    
    // Assign tiles to quadrants relative to center (creates 4 groups)
    // Group 0: top-left, Group 1: top-right, Group 2: bottom-left, Group 3: bottom-right
    const isRight = col >= centerTileCol;
    const isBottom = row >= centerTileRow;
    
    if (!isBottom && !isRight) return '0'; // top-left
    if (!isBottom && isRight) return '1';  // top-right
    if (isBottom && !isRight) return '2';  // bottom-left
    return '3'; // bottom-right
  }, [viewportWidth, viewportHeight, tileSize, largeTileSize]);

  // Animation controller - randomly pick tiles to animate (with pool limit and group constraints)
  const triggerRandomAnimation = useCallback(() => {
    // Don't trigger if we're at max capacity
    if (animatingTiles.length >= MAX_CONCURRENT_ANIMATIONS) {
      return;
    }
    
    // Get tiles that have EVER had colors > 0 (animation-ready tiles)
    const animationReadyTiles: TilePosition[] = [];
    
    // Calculate grid origin
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight * 0.4;
    const largeTileHalf = largeTileSize / 2;
    const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
    const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
    const gridOriginX = centerX - largeTileHalf - (tilesLeft * tileSize);
    const gridOriginY = centerY - largeTileHalf - (tilesUp * tileSize);
    
    everColoredTiles.forEach((key) => {
      const [row, col] = key.split(',').map(Number);
      const x = gridOriginX + col * tileSize;
      const y = gridOriginY + row * tileSize;
      animationReadyTiles.push({ row, col, x, y });
    });

    if (animationReadyTiles.length === 0) return;

    // Get groups that currently have active animations
    const activeGroups = new Set<string>();
    animatingTiles.forEach((animating) => {
      const groupId = getGroupId(animating.position.row, animating.position.col);
      activeGroups.add(groupId);
    });

    // Filter for tiles that:
    // 1. Are not currently animating
    // 2. Are in groups that don't have an active animation
    const availableTiles = animationReadyTiles.filter((tile) => {
      const isAnimating = animatingTiles.some(
        (animating) =>
          animating.position.row === tile.row && animating.position.col === tile.col
      );
      if (isAnimating) return false;

      const groupId = getGroupId(tile.row, tile.col);
      return !activeGroups.has(groupId);
    });

    if (availableTiles.length === 0) return;

    const randomTile = availableTiles[Math.floor(Math.random() * availableTiles.length)];

    // Cycle through animations
    const animationId = availableAnimations[currentAnimationIndexRef.current];
    currentAnimationIndexRef.current =
      (currentAnimationIndexRef.current + 1) % availableAnimations.length;

    // Add to animating tiles
    const newAnimatingTile: AnimatingTile = {
      position: randomTile,
      animationId,
      startTime: performance.now(),
      currentFrame: 0,
    };

    setAnimatingTiles((prev) => [...prev, newAnimatingTile]);
  }, [everColoredTiles, animatingTiles, availableAnimations, viewportWidth, viewportHeight, tileSize, largeTileSize, getGroupId]);

  // Function to remove a completed animation
  const removeAnimatingTile = useCallback((tile: AnimatingTile) => {
    setAnimatingTiles((prev) => {
      return prev.filter(
        (t) =>
          !(
            t.position.row === tile.position.row &&
            t.position.col === tile.position.col &&
            t.startTime === tile.startTime
          )
      );
    });
  }, []);

  // Handle delay after enabled becomes true
  useEffect(() => {
    if (!enabled) {
      setDelayPassed(false);
      enabledTimeRef.current = null;
      return;
    }

    // Record when enabled became true
    if (enabledTimeRef.current === null) {
      enabledTimeRef.current = performance.now();
    }

    // Set up timer to mark delay as passed after 800ms
    const timeoutId = setTimeout(() => {
      setDelayPassed(true);
    }, START_DELAY_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [enabled, START_DELAY_MS]);

  // Animation loop with pool management
  useEffect(() => {
    if (!enabled || !delayPassed) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      hasStartedRef.current = false;
      hasReachedMaxRef.current = false;
      isRefillingRef.current = false;
      return;
    }

    // Start with 1 animation immediately
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      triggerRandomAnimation();
    }

    const animate = (timestamp: number) => {
      const poolSize = animatingTiles.length;
      
      // Track if we've reached max capacity
      if (poolSize >= MAX_CONCURRENT_ANIMATIONS) {
        hasReachedMaxRef.current = true;
        isRefillingRef.current = false; // Stop refilling once we hit max
      }
      
      // Start refilling if pool drops to 1 (after having reached max)
      // BUT NOT if an agent is selected (let animations go to 0)
      if (hasReachedMaxRef.current && poolSize <= 1 && !selectedAgentId) {
        isRefillingRef.current = true;
      }
      
      // If an agent is selected, stop refilling immediately
      if (selectedAgentId && isRefillingRef.current) {
        isRefillingRef.current = false;
      }
      
      // Determine if we should add more animations:
      // - During initial ramp-up: add until we reach 4
      // - During refill: continue adding until we reach 4 (even if pool size fluctuates)
      // - BUT NOT if an agent is selected
      const isInitialRampUp = !hasReachedMaxRef.current;
      const isRefilling = isRefillingRef.current;
      const shouldAdd = (isInitialRampUp || isRefilling) && !selectedAgentId;
      const isBelowMax = poolSize < MAX_CONCURRENT_ANIMATIONS;
      
      if (
        isBelowMax &&
        shouldAdd &&
        timestamp - lastTriggerTimeRef.current >= animationInterval
      ) {
        triggerRandomAnimation();
        lastTriggerTimeRef.current = timestamp;
      }

      // Continue animation loop
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [enabled, delayPassed, animationInterval, triggerRandomAnimation, animatingTiles.length, MAX_CONCURRENT_ANIMATIONS]);

  return {
    animatingTiles,
    removeAnimatingTile,
  };
}

