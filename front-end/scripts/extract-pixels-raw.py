#!/usr/bin/env python3
"""
Extract RAW pixel values from video - NO PROCESSING AT ALL.
Just read what's there and apply delta compression.
"""

import cv2
import numpy as np
import json
from pathlib import Path

def extract_pixels_raw(video_path, crop_percent=0.05):
    """
    Extract RAW pixels - NO resizing, NO processing, just read the values!
    
    Args:
        video_path: Path to the video file
        crop_percent: Percentage to crop from each side
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
    print(f"🚫 NO PROCESSING - just reading raw pixel values!")
    
    # Calculate final dimensions after crop
    if crop_percent > 0:
        crop_x = int(width * crop_percent)
        crop_y = int(height * crop_percent)
        final_width = width - (2 * crop_x)
        final_height = height - (2 * crop_y)
        print(f"Crop: {crop_percent*100}% from each side → {final_width}×{final_height}")
    else:
        final_width = width
        final_height = height
    
    frames_data = []
    
    for frame_idx in range(total_frames):
        ret, frame = cap.read()
        
        if not ret:
            print(f"Warning: Could not read frame {frame_idx}")
            break
        
        # Convert BGR to RGB (OpenCV reads as BGR)
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Crop if needed - NO RESIZING!
        if crop_percent > 0:
            crop_x = int(width * crop_percent)
            crop_y = int(height * crop_percent)
            frame_rgb = frame_rgb[crop_y:height-crop_y, crop_x:width-crop_x]
        
        # That's it! Just flatten to [r,g,b,r,g,b,...]
        flat_pixels = frame_rgb.flatten().tolist()
        frames_data.append(flat_pixels)
        
        if (frame_idx + 1) % 50 == 0:
            print(f"Processed frame {frame_idx + 1}/{total_frames}")
    
    cap.release()
    
    # Create metadata
    duration_ms = (total_frames / fps) * 1000
    
    output_data = {
        "id": "animation-1",
        "fps": int(fps),
        "duration_ms": duration_ms,
        "frame_count": len(frames_data),
        "width": final_width,
        "height": final_height,
        "format": "flat_rgb",
        "description": "RAW pixel values - no processing, no resizing, just the video as-is",
        "frames": frames_data
    }
    
    return output_data

def compute_delta_frames(frames_data, width, height):
    """
    Compress frames using delta encoding - LOSSLESS!
    Only store pixels that changed from the previous frame.
    """
    print("\n🗜️  Computing delta compression (lossless)...")
    
    compressed_frames = []
    threshold = 0  # Store ALL changes (lossless)
    
    for frame_idx, frame_pixels in enumerate(frames_data):
        if frame_idx == 0:
            # First frame: store complete
            compressed_frames.append({
                "type": "full",
                "pixels": frame_pixels
            })
            print(f"Frame 0: Full frame ({len(frame_pixels)} values)")
        else:
            # Subsequent frames: compute delta from previous
            prev_pixels = frames_data[frame_idx - 1]
            deltas = []
            
            for i in range(0, len(frame_pixels), 3):
                r, g, b = frame_pixels[i], frame_pixels[i+1], frame_pixels[i+2]
                pr, pg, pb = prev_pixels[i], prev_pixels[i+1], prev_pixels[i+2]
                
                # Check if pixel changed AT ALL (lossless)
                if r != pr or g != pg or b != pb:
                    # Store: [pixel_index, r, g, b]
                    deltas.append([i // 3, r, g, b])
            
            # If too many changes (>50%), store as full frame
            if len(deltas) > (width * height * 0.5):
                compressed_frames.append({
                    "type": "full",
                    "pixels": frame_pixels
                })
                if (frame_idx + 1) % 50 == 0:
                    print(f"Frame {frame_idx}: Full frame (too many changes)")
            else:
                compressed_frames.append({
                    "type": "delta",
                    "base": frame_idx - 1,
                    "deltas": deltas
                })
                if (frame_idx + 1) % 50 == 0:
                    savings = 100 * (1 - (len(deltas) * 4) / len(frame_pixels))
                    print(f"Frame {frame_idx}: Delta ({len(deltas)} changes, {savings:.1f}% savings)")
    
    return compressed_frames

def main():
    # Input video path
    video_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1.mov"
    
    if not video_path.exists():
        print(f"❌ Video not found: {video_path}")
        return
    
    print(f"📹 Input: {video_path}")
    print(f"\n🔄 Extracting RAW pixels (no processing)...\n")
    
    # Extract RAW pixels - no resizing, no processing
    pixel_data = extract_pixels_raw(
        video_path,
        crop_percent=0.05  # Just crop edges
    )
    
    # Compute LOSSLESS delta compression
    compressed_frames = compute_delta_frames(
        pixel_data["frames"],
        pixel_data["width"],
        pixel_data["height"]
    )
    
    # Replace frames with compressed version
    pixel_data["frames"] = compressed_frames
    pixel_data["compressed"] = True
    
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
    print(f"   Size: {pixel_data['width']}×{pixel_data['height']}")
    print(f"\n🎯 RAW pixels with lossless delta compression!")

if __name__ == "__main__":
    main()

