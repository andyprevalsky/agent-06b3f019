#!/usr/bin/env python3
"""
Center all animations by finding and centering the dark dot.
"""

import cv2
import numpy as np
from pathlib import Path

def find_dark_dot(frame):
    """Find dark circular dot in frame."""
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
    darkest_val = min_val[0]
    
    return (darkest_x, darkest_y)

def center_animation(anim_num):
    """Center a single animation."""
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    input_path = base_dir / f"animation-{anim_num}.mov"
    centered_path = base_dir / f"animation-{anim_num}-centered.mov"
    original_backup = base_dir / f"animation-{anim_num}-original.mov"
    
    if not input_path.exists():
        print(f"  ⚠️  animation-{anim_num}.mov not found, skipping")
        return False
    
    print(f"\n📹 Processing animation-{anim_num}.mov...")
    
    # Read first frame
    cap = cv2.VideoCapture(str(input_path))
    ret, frame = cap.read()
    
    if not ret:
        print(f"  ❌ Could not read frame")
        cap.release()
        return False
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Find dot
    dot_x, dot_y = find_dark_dot(frame)
    print(f"  Dot at: ({dot_x}, {dot_y})")
    
    # Calculate centered crop
    output_size = min(width, height)
    crop_x = dot_x - output_size // 2
    crop_y = dot_y - output_size // 2
    
    # Adjust if out of bounds
    if crop_x < 0 or crop_y < 0 or crop_x + output_size > width or crop_y + output_size > height:
        max_left = dot_x
        max_right = width - dot_x
        max_top = dot_y
        max_bottom = height - dot_y
        output_size = min(max_left, max_right, max_top, max_bottom) * 2
        crop_x = dot_x - output_size // 2
        crop_y = dot_y - output_size // 2
        print(f"  Adjusted to {output_size}×{output_size}")
    
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    
    print(f"  Output: {output_size}×{output_size}")
    print(f"  Dot will be at: ({out_dot_x}, {out_dot_y}), center: ({output_size//2}, {output_size//2})")
    print(f"  ✓ Centered: {out_dot_x == output_size//2 and out_dot_y == output_size//2}")
    
    # Write centered video with lossless settings
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    # Use high-quality codec settings to preserve colors
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')  # MPEG-4 codec
    out = cv2.VideoWriter(str(centered_path), fourcc, fps, (output_size, output_size))
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        cropped = frame[crop_y:crop_y+output_size, crop_x:crop_x+output_size]
        out.write(cropped)
        frame_count += 1
    
    cap.release()
    out.release()
    
    print(f"  ✅ Processed {frame_count} frames")
    
    # Backup original and replace
    if original_backup.exists():
        original_backup.unlink()
    input_path.rename(original_backup)
    centered_path.rename(input_path)
    
    return True

def main():
    print("🎬 Centering all animations...\n")
    
    for anim_num in [1, 2, 3, 4]:
        center_animation(anim_num)
    
    print("\n🎯 All animations centered!")
    print("\nNow run: python3 scripts/extract-all-animations.py")

if __name__ == "__main__":
    main()

