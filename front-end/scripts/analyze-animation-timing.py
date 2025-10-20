#!/usr/bin/env python3
"""
Analyze animation to find start/end frames (when dot actually changes).
"""

import cv2
import numpy as np
from pathlib import Path

def analyze_animation_timing(video_path):
    """Find when animation starts and ends."""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {video_path}")
        return None
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    
    print(f"\n📹 Analyzing {video_path.name}...")
    print(f"   Total frames: {total_frames} ({total_frames/fps:.2f}s @ {fps} FPS)")
    
    # Read first frame as reference
    ret, first_frame = cap.read()
    if not ret:
        return None
    
    gray_first = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)
    
    # Analyze frame differences to detect motion
    differences = []
    frame_idx = 0
    prev_gray = gray_first.copy()
    
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Calculate difference from previous frame
        diff = cv2.absdiff(gray, prev_gray)
        diff_score = np.mean(diff)
        
        differences.append(diff_score)
        prev_gray = gray
        frame_idx += 1
    
    cap.release()
    
    # Find start: first significant change from baseline
    baseline = np.mean(differences[:10])  # Average of first 10 frames
    threshold = baseline + 2.0  # Significant change threshold
    
    start_frame = 0
    for i, diff in enumerate(differences):
        if diff > threshold:
            start_frame = max(0, i - 2)  # Include 2 frames before
            break
    
    # Find end: last significant change
    end_frame = len(differences) - 1
    for i in range(len(differences) - 1, -1, -1):
        if differences[i] > threshold:
            end_frame = min(len(differences) - 1, i + 10)  # Include 10 frames after
            break
    
    # Show statistics
    print(f"\n   Analysis:")
    print(f"   Baseline diff: {baseline:.2f}")
    print(f"   Threshold: {threshold:.2f}")
    print(f"   Max diff: {max(differences):.2f}")
    print(f"\n   ✂️  Trim suggestion:")
    print(f"   Keep frames: {start_frame} to {end_frame} ({end_frame - start_frame + 1} frames)")
    print(f"   Remove start: {start_frame} frames ({start_frame/fps:.2f}s)")
    print(f"   Remove end: {total_frames - end_frame - 1} frames ({(total_frames - end_frame - 1)/fps:.2f}s)")
    print(f"   New duration: {(end_frame - start_frame + 1)/fps:.2f}s")
    
    return (start_frame, end_frame)

def trim_video(input_path, output_path, start_frame, end_frame):
    """Trim video to specified frame range."""
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        return False
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    # Setup output writer
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
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
    
    print(f"   ✅ Trimmed: {frame_count} frames written")
    
    return True

def main():
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    
    print("🎬 Analyzing animation timing...\n")
    
    for anim_num in [1, 2, 3, 4]:
        input_path = base_dir / f"animation-{anim_num}.mov"
        
        if not input_path.exists():
            print(f"⚠️  animation-{anim_num}.mov not found")
            continue
        
        # Analyze
        timing = analyze_animation_timing(input_path)
        
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
            
            print(f"   ✅ Replaced animation-{anim_num}.mov with trimmed version\n")
    
    print("\n🎯 Done! Now re-extract frames with: python3 scripts/extract-all-animations.py")

if __name__ == "__main__":
    main()

