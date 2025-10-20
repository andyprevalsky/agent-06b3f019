#!/usr/bin/env python3
"""
Debug animation-3 centering issue.
"""

import cv2
import numpy as np
from pathlib import Path

def find_dot_center(frame):
    """Find dark dot center with detailed output."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # Mask out edges
    height, width = gray.shape
    mask = np.ones(gray.shape, dtype=np.uint8) * 255
    mask[0:50, :] = 0
    mask[-50:, :] = 0
    mask[:, 0:50] = 0
    mask[:, -50:] = 0
    
    # Find darkest point
    masked = cv2.bitwise_and(gray, gray, mask=mask)
    min_val = cv2.minMaxLoc(masked, mask=mask)
    
    darkest_x, darkest_y = min_val[2]
    darkest_value = min_val[0]
    
    print(f"   Frame size: {width}×{height}")
    print(f"   Frame center: ({width//2}, {height//2})")
    print(f"   Darkest point: ({darkest_x}, {darkest_y}), value: {darkest_value}")
    
    return (darkest_x, darkest_y)

def main():
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-3-unstd.mov"
    
    if not input_path.exists():
        print("❌ animation-3-unstd.mov not found")
        return
    
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print("❌ Could not open video")
        return
    
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print("❌ Could not read frame")
        return
    
    print("\n🔍 Analyzing animation-3 first frame:\n")
    dot_x, dot_y = find_dot_center(frame)
    
    # Show what would happen with different crop strategies
    width, height = frame.shape[1], frame.shape[0]
    target_size = 222
    
    print(f"\n📐 Cropping to {target_size}×{target_size}:")
    print(f"\n   Strategy 1: Center on detected dot ({dot_x}, {dot_y})")
    crop_x = dot_x - target_size // 2
    crop_y = dot_y - target_size // 2
    crop_x = max(0, min(crop_x, width - target_size))
    crop_y = max(0, min(crop_y, height - target_size))
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    print(f"   Crop region: x={crop_x}, y={crop_y}")
    print(f"   Dot in output: ({out_dot_x}, {out_dot_y})")
    print(f"   Expected center: ({target_size//2}, {target_size//2})")
    print(f"   Offset: ({out_dot_x - target_size//2}, {out_dot_y - target_size//2})")
    
    print(f"\n   Strategy 2: Center on frame center ({width//2}, {height//2})")
    crop_x = width//2 - target_size // 2
    crop_y = height//2 - target_size // 2
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    print(f"   Crop region: x={crop_x}, y={crop_y}")
    print(f"   Dot in output: ({out_dot_x}, {out_dot_y})")
    print(f"   Expected center: ({target_size//2}, {target_size//2})")
    print(f"   Offset: ({out_dot_x - target_size//2}, {out_dot_y - target_size//2})")

if __name__ == "__main__":
    main()

