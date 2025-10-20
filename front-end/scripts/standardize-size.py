#!/usr/bin/env python3
"""
Standardize all animations to the same size (smallest one: 222×222).
Ensures dots stay centered.
"""

import cv2
import numpy as np
from pathlib import Path

TARGET_SIZE = 222  # Size after 5% crop - matches animation-1

def find_dot_center(frame):
    """Find dark dot center."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # Mask out edges
    mask = np.ones(gray.shape, dtype=np.uint8) * 255
    mask[0:50, :] = 0
    mask[-50:, :] = 0
    mask[:, 0:50] = 0
    mask[:, -50:] = 0
    
    # Find darkest point
    masked = cv2.bitwise_and(gray, gray, mask=mask)
    min_val = cv2.minMaxLoc(masked, mask=mask)
    
    darkest_x, darkest_y = min_val[2]
    return (darkest_x, darkest_y)

def resize_and_center(input_path, output_path, target_size):
    """Resize video to target size, keeping dot centered."""
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open: {input_path}")
        return False
    
    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"   Input: {width}×{height}")
    
    if width == target_size and height == target_size:
        print(f"   ✓ Already {target_size}×{target_size}, skipping")
        cap.release()
        return False
    
    # Read first frame to find dot
    ret, first_frame = cap.read()
    if not ret:
        cap.release()
        return False
    
    dot_x, dot_y = find_dot_center(first_frame)
    print(f"   Dot at: ({dot_x}, {dot_y})")
    
    # Calculate crop to get target size with dot centered
    crop_x = dot_x - target_size // 2
    crop_y = dot_y - target_size // 2
    
    # Ensure crop is within bounds
    crop_x = max(0, min(crop_x, width - target_size))
    crop_y = max(0, min(crop_y, height - target_size))
    
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    
    print(f"   Output: {target_size}×{target_size}")
    print(f"   Dot will be at: ({out_dot_x}, {out_dot_y}), center: ({target_size//2}, {target_size//2})")
    print(f"   Centered: {out_dot_x == target_size//2 and out_dot_y == target_size//2}")
    
    # Reset and process video
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (target_size, target_size))
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Crop to target size
        cropped = frame[crop_y:crop_y+target_size, crop_x:crop_x+target_size]
        out.write(cropped)
        frame_count += 1
    
    cap.release()
    out.release()
    
    print(f"   ✅ Processed {frame_count} frames")
    return True

def main():
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    
    print(f"📐 Standardizing all animations to {TARGET_SIZE}×{TARGET_SIZE}...\n")
    
    for anim_num in [1, 2, 3, 4]:
        input_path = base_dir / f"animation-{anim_num}.mov"
        
        if not input_path.exists():
            print(f"⚠️  animation-{anim_num}.mov not found")
            continue
        
        print(f"📹 Processing animation-{anim_num}.mov...")
        
        resized_path = base_dir / f"animation-{anim_num}-std.mov"
        changed = resize_and_center(input_path, resized_path, TARGET_SIZE)
        
        if changed:
            # Replace original
            backup_path = base_dir / f"animation-{anim_num}-unstd.mov"
            if backup_path.exists():
                backup_path.unlink()
            input_path.rename(backup_path)
            resized_path.rename(input_path)
            print(f"   ✅ Replaced with standardized version\n")
        else:
            print()
    
    print(f"🎯 All animations standardized to {TARGET_SIZE}×{TARGET_SIZE}!")
    print(f"\nNow extract: python3 scripts/extract-all-animations.py")

if __name__ == "__main__":
    main()

