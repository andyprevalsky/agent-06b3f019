#!/usr/bin/env python3
"""
Show per-frame differences for analysis.
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

def analyze_frame_differences(video_path):
    """Analyze frame-by-frame differences."""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {video_path}")
        return
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    print(f"📹 {video_path.name}")
    print(f"   {total_frames} frames @ {fps} FPS, {width}×{height}\n")
    
    # Create mask for center circle
    mask = get_center_circle_mask(width, height, radius_percent=0.25)
    
    # Read first frame
    ret, first_frame = cap.read()
    if not ret:
        cap.release()
        return
    
    first_gray = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)
    prev_gray = first_gray.copy()
    
    # Analyze
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    differences = []
    
    print("Frame | Diff")
    print("------|-------")
    
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Calculate difference ONLY in center circle
        diff = cv2.absdiff(gray, prev_gray)
        masked_diff = cv2.bitwise_and(diff, diff, mask=mask)
        diff_score = np.mean(masked_diff[mask > 0])
        
        differences.append(diff_score)
        
        # Print first 100 frames
        if frame_idx < 100:
            marker = ""
            if diff_score > 0.01:
                marker = " ← CHANGE"
            print(f"{frame_idx:5d} | {diff_score:7.3f}{marker}")
        
        prev_gray = gray
        frame_idx += 1
    
    cap.release()
    
    # Summary
    baseline = np.median(differences[:20])
    print(f"\n...")
    print(f"\nSummary:")
    print(f"  Baseline (first 20 frames): {baseline:.3f}")
    print(f"  Max diff: {max(differences):.3f}")
    print(f"  First change > 0.01: frame {next((i for i, d in enumerate(differences) if d > 0.01), None)}")
    print(f"  First change > 0.05: frame {next((i for i, d in enumerate(differences) if d > 0.05), None)}")
    print(f"  First change > 0.10: frame {next((i for i, d in enumerate(differences) if d > 0.10), None)}")
    print(f"  First change > 0.30: frame {next((i for i, d in enumerate(differences) if d > 0.30), None)}")

def main():
    # Analyze animation-1 untrimmed
    video_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1-untrimmed.mov"
    
    if not video_path.exists():
        print(f"❌ animation-1-untrimmed.mov not found")
        return
    
    analyze_frame_differences(video_path)

if __name__ == "__main__":
    main()

