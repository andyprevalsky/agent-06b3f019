#!/usr/bin/env python3
"""
Manual dot finder - shows first frame and lets you click on the dot center.
"""

import cv2
import numpy as np
from pathlib import Path

dot_center = None

def mouse_callback(event, x, y, flags, param):
    global dot_center
    if event == cv2.EVENT_LBUTTONDOWN:
        dot_center = (x, y)
        print(f"✓ Dot center selected at: ({x}, {y})")

def find_dot_manually(input_path):
    global dot_center
    
    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        print(f"❌ Could not open video: {input_path}")
        return None
    
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print("❌ Could not read first frame")
        return None
    
    height, width = frame.shape[:2]
    
    # Draw frame center for reference
    center_x, center_y = width // 2, height // 2
    display = frame.copy()
    cv2.line(display, (center_x - 30, center_y), (center_x + 30, center_y), (0, 255, 0), 1)
    cv2.line(display, (center_x, center_y - 30), (center_x, center_y + 30), (0, 255, 0), 1)
    cv2.putText(display, f"Frame center ({center_x},{center_y})", 
                (center_x + 10, center_y - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    
    # Show frame and wait for click
    cv2.namedWindow('Click on dot center', cv2.WINDOW_NORMAL)
    cv2.setMouseCallback('Click on dot center', mouse_callback)
    cv2.imshow('Click on dot center', display)
    
    print("\n👆 Click on the CENTER of the dot in the image, then press any key...")
    cv2.waitKey(0)
    cv2.destroyAllWindows()
    
    return dot_center

def crop_video_with_manual_center(input_path, output_path, dot_center):
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        return
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    dot_x, dot_y = dot_center
    output_size = min(width, height)
    
    # Calculate crop region centered on dot
    crop_x = dot_x - output_size // 2
    crop_y = dot_y - output_size // 2
    
    # Clamp to valid region
    crop_x = max(0, min(crop_x, width - output_size))
    crop_y = max(0, min(crop_y, height - output_size))
    
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    
    print(f"\n📐 Crop details:")
    print(f"   Input: {width}×{height}")
    print(f"   Dot at: ({dot_x}, {dot_y})")
    print(f"   Crop region: x={crop_x}, y={crop_y}, size={output_size}×{output_size}")
    print(f"   Dot will be at: ({out_dot_x}, {out_dot_y}) in output")
    print(f"   Output center: ({output_size//2}, {output_size//2})")
    print(f"   Offset from center: ({out_dot_x - output_size//2}, {out_dot_y - output_size//2})")
    
    # Setup output
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (output_size, output_size))
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        cropped = frame[crop_y:crop_y+output_size, crop_x:crop_x+output_size]
        out.write(cropped)
        
        frame_count += 1
        if frame_count % 50 == 0:
            print(f"   Processed {frame_count}/{total_frames} frames")
    
    cap.release()
    out.release()
    
    print(f"\n✅ Saved: {output_path}")

def main():
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test.mp4"
    output_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test-centered.mp4"
    
    if not input_path.exists():
        print(f"❌ Video not found: {input_path}")
        return
    
    dot_pos = find_dot_manually(input_path)
    
    if dot_pos is None:
        print("❌ No dot selected")
        return
    
    crop_video_with_manual_center(input_path, output_path, dot_pos)
    print("\n🎯 Done!")

if __name__ == "__main__":
    main()

