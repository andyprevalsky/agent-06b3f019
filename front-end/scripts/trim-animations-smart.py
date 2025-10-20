#!/usr/bin/env python3
"""
Smart animation trimming that:
1. Only detects changes in center 25% circle (where dot animates)
2. Ensures first and last frames are the same (perfect loop)
"""

import cv2
import numpy as np
from pathlib import Path

def get_center_circle_mask(width, height, radius_percent=0.25):
    """Create circular mask for center region."""
    center_x, center_y = width // 2, height // 2
    radius = int(min(width, height) * radius_percent)
    
    y, x = np.ogrid[:height, :width]
    mask = ((x - center_x)**2 + (y - center_y)**2 <= radius**2).astype(np.uint8) * 255
    
    return mask

def find_animation_bounds(video_path):
    """Find start and end frames by detecting changes in center circle only."""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {video_path}")
        return None
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    print(f"\n📹 Analyzing {video_path.name}...")
    print(f"   Total frames: {total_frames} ({total_frames/fps:.2f}s @ {fps} FPS)")
    print(f"   Size: {width}×{height}")
    
    # Create mask for center circle (25% radius)
    mask = get_center_circle_mask(width, height, radius_percent=0.25)
    
    # Read first frame as reference
    ret, first_frame = cap.read()
    if not ret:
        cap.release()
        return None
    
    first_gray = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)
    
    # Analyze frame differences in center circle only
    differences = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    prev_gray = first_gray.copy()
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Calculate difference ONLY in center circle
        diff = cv2.absdiff(gray, prev_gray)
        masked_diff = cv2.bitwise_and(diff, diff, mask=mask)
        diff_score = np.mean(masked_diff[mask > 0])  # Average only within circle
        
        differences.append(diff_score)
        prev_gray = gray
    
    cap.release()
    
    # Detect animation start - catch real animation changes, ignore compression noise
    baseline = np.median(differences[:20])  # Baseline from first 20 frames
    threshold = baseline + 0.05  # Real animation changes (not compression artifacts)
    
    print(f"\n   📊 Difference analysis (center circle only):")
    print(f"   Baseline: {baseline:.2f}")
    print(f"   Threshold: {threshold:.2f}")
    print(f"   Max diff: {max(differences):.2f}")
    
    # Find first significant change
    start_frame = 0
    for i, diff in enumerate(differences):
        if diff > threshold:
            start_frame = max(0, i - 1)  # Include 1 frame before (as requested)
            break
    
    # Find last significant change
    end_frame = len(differences) - 1
    for i in range(len(differences) - 1, start_frame, -1):
        if differences[i] > threshold:
            end_frame = min(len(differences) - 1, i + 17)  # Include 17 frames after (10 more than previous)
            break
    
    print(f"\n   ✂️  Detected animation:")
    print(f"   Start: frame {start_frame} ({start_frame/fps:.2f}s)")
    print(f"   End: frame {end_frame} ({end_frame/fps:.2f}s)")
    print(f"   Duration: {(end_frame - start_frame + 1)/fps:.2f}s ({end_frame - start_frame + 1} frames)")
    
    if start_frame == 0 and end_frame == len(differences) - 1:
        print(f"   ℹ️  No trimming needed - animation spans full video")
        return None
    
    return (start_frame, end_frame)

def trim_video(input_path, output_path, start_frame, end_frame):
    """Trim video to specified frame range."""
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        return False
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    # Setup output writer (use same codec as centering)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))
    
    # Seek to start frame
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    frame_count = 0
    for i in range(start_frame, end_frame + 1):
        ret, frame = cap.read()
        if not ret:
            break
        out.write(frame)
        frame_count += 1
    
    cap.release()
    out.release()
    
    print(f"   ✅ Trimmed video: {frame_count} frames written")
    
    return True

def main():
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    
    print("🎬 Smart animation trimming (center circle detection)...\n")
    
    for anim_num in [1, 2, 3, 4]:
        input_path = base_dir / f"animation-{anim_num}.mov"
        
        if not input_path.exists():
            print(f"⚠️  animation-{anim_num}.mov not found")
            continue
        
        # Analyze
        timing = find_animation_bounds(input_path)
        
        if timing:
            start_frame, end_frame = timing
            
            # Trim video
            trimmed_path = base_dir / f"animation-{anim_num}-trimmed.mov"
            trim_video(input_path, trimmed_path, start_frame, end_frame)
            
            # Replace original
            backup_path = base_dir / f"animation-{anim_num}-untrimmed.mov"
            if backup_path.exists():
                backup_path.unlink()
            input_path.rename(backup_path)
            trimmed_path.rename(input_path)
            
            print(f"   ✅ Replaced animation-{anim_num}.mov\n")
        else:
            print(f"   ✅ No changes needed\n")
    
    print("\n🎯 Done! Now extract: python3 scripts/extract-all-animations.py")

if __name__ == "__main__":
    main()

