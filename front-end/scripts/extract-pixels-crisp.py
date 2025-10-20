#!/usr/bin/env python3
"""
Extract pixel-perfect frames from animation video.
Uses nearest-neighbor scaling to avoid blur/smoothing.
"""

import cv2
import numpy as np
import json
from pathlib import Path

def extract_pixels_crisp(video_path, crop_percent=0.05):
    """
    Extract frames from video - just read raw pixel values, NO RESIZING!
    
    Args:
        video_path: Path to the video file
        crop_percent: Percentage to crop from each side (0.0 to 0.5)
    """
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")
    
    # Get video properties
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    print(f"Video: {total_frames} frames @ {fps} FPS")
    print(f"Original size: {width}×{height}")
    print(f"⚠️  NO RESIZING - reading raw pixel values directly!")
    if crop_percent > 0:
        crop_x = int(width * crop_percent)
        crop_y = int(height * crop_percent)
        final_width = width - (2 * crop_x)
        final_height = height - (2 * crop_y)
        print(f"Crop: {crop_percent*100}% from each side → {final_width}×{final_height}")
    
    frames_data = []
    output_width = None
    output_height = None
    
    for frame_idx in range(total_frames):
        ret, frame = cap.read()
        
        if not ret:
            print(f"Warning: Could not read frame {frame_idx}")
            break
        
        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Crop (5% from each side) - NO RESIZING!
        if crop_percent > 0:
            crop_x = int(width * crop_percent)
            crop_y = int(height * crop_percent)
            frame_rgb = frame_rgb[
                crop_y:height-crop_y,
                crop_x:width-crop_x
            ]
        
        # NO RESIZING - just read the raw pixel values!
        # Store dimensions from first frame
        if output_width is None:
            output_height, output_width = frame_rgb.shape[:2]
            print(f"Output size (raw pixels): {output_width}×{output_height}")
        
        # Flatten to [r,g,b,r,g,b,...]
        flat_pixels = frame_rgb.flatten().tolist()
        frames_data.append(flat_pixels)
        
        if (frame_idx + 1) % 10 == 0:
            print(f"Processed frame {frame_idx + 1}/{total_frames}")
    
    cap.release()
    
    # Create metadata
    duration_ms = (total_frames / fps) * 1000
    
    output_data = {
        "id": "animation-1",
        "fps": int(fps),
        "duration_ms": duration_ms,
        "frame_count": len(frames_data),
        "width": output_width,
        "height": output_height,
        "format": "flat_rgb",
        "description": "Raw pixel values extracted directly from video - NO resizing, NO interpolation, NO blur!",
        "frames": frames_data
    }
    
    return output_data

def main():
    # Input video path
    video_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1.mov"
    
    if not video_path.exists():
        print(f"❌ Video not found: {video_path}")
        return
    
    print(f"📹 Input: {video_path}")
    print(f"\n🔄 Extracting pixels with NEAREST NEIGHBOR scaling (no blur)...\n")
    
    # Extract raw pixels - NO resizing!
    pixel_data = extract_pixels_crisp(
        video_path,
        crop_percent=0.05
    )
    
    # Save to output
    output_path = Path(__file__).parent.parent / "src" / "lib" / "animation-1-pixels.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    print(f"\n💾 Saving to {output_path}...")
    with open(output_path, 'w') as f:
        json.dump(pixel_data, f, separators=(',', ':'))  # Compact JSON
    
    # Get file size
    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"✅ Complete! File size: {file_size_mb:.1f} MB")
    print(f"   Frames: {pixel_data['frame_count']}")
    print(f"   FPS: {pixel_data['fps']}")
    print(f"   Duration: {pixel_data['duration_ms']/1000:.2f}s")
    print(f"\n🎯 Pixels are now CRISP with no blur!")

if __name__ == "__main__":
    main()

