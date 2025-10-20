#!/usr/bin/env python3
"""
Extract ALL animations (1, 2, 3) with RAW pixels + lossless delta compression.
"""

import cv2
import numpy as np
import json
from pathlib import Path

def extract_pixels_raw(video_path, crop_percent=0.05):
    """Extract RAW pixels - NO resizing, NO processing"""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    print(f"  Video: {total_frames} frames @ {fps} FPS, {width}×{height}")
    
    if crop_percent > 0:
        crop_x = int(width * crop_percent)
        crop_y = int(height * crop_percent)
        final_width = width - (2 * crop_x)
        final_height = height - (2 * crop_y)
        print(f"  Output: {final_width}×{final_height} (5% crop)")
    else:
        final_width = width
        final_height = height
    
    frames_data = []
    
    for frame_idx in range(total_frames):
        ret, frame = cap.read()
        if not ret:
            break
        
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        if crop_percent > 0:
            crop_x = int(width * crop_percent)
            crop_y = int(height * crop_percent)
            frame_rgb = frame_rgb[crop_y:height-crop_y, crop_x:width-crop_x]
        
        flat_pixels = frame_rgb.flatten().tolist()
        frames_data.append(flat_pixels)
    
    cap.release()
    
    duration_ms = (total_frames / fps) * 1000
    
    return {
        "fps": int(fps),
        "duration_ms": duration_ms,
        "frame_count": len(frames_data),
        "width": final_width,
        "height": final_height,
        "format": "flat_rgb",
        "frames": frames_data
    }

def compute_delta_frames(frames_data, width, height):
    """Lossless delta compression"""
    compressed_frames = []
    
    for frame_idx, frame_pixels in enumerate(frames_data):
        if frame_idx == 0:
            compressed_frames.append({
                "type": "full",
                "pixels": frame_pixels
            })
        else:
            prev_pixels = frames_data[frame_idx - 1]
            deltas = []
            
            for i in range(0, len(frame_pixels), 3):
                r, g, b = frame_pixels[i], frame_pixels[i+1], frame_pixels[i+2]
                pr, pg, pb = prev_pixels[i], prev_pixels[i+1], prev_pixels[i+2]
                
                if r != pr or g != pg or b != pb:
                    deltas.append([i // 3, r, g, b])
            
            if len(deltas) > (width * height * 0.5):
                compressed_frames.append({
                    "type": "full",
                    "pixels": frame_pixels
                })
            else:
                compressed_frames.append({
                    "type": "delta",
                    "base": frame_idx - 1,
                    "deltas": deltas
                })
    
    return compressed_frames

def main():
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    output_dir = Path(__file__).parent.parent / "src" / "lib"
    
    # Process animations 1, 2, 3, 4
    for anim_num in [1, 2, 3, 4]:
        video_path = base_dir / f"animation-{anim_num}.mov"
        
        if not video_path.exists():
            print(f"⚠️  Skipping animation-{anim_num}.mov (not found)")
            continue
        
        print(f"\n📹 Processing animation-{anim_num}.mov...")
        
        # Extract raw pixels
        pixel_data = extract_pixels_raw(video_path, crop_percent=0.05)
        
        # Add ID
        pixel_data["id"] = f"animation-{anim_num}"
        pixel_data["description"] = "RAW pixels with lossless delta compression"
        
        # Compress with deltas
        print(f"  🗜️  Computing delta compression...")
        compressed_frames = compute_delta_frames(
            pixel_data["frames"],
            pixel_data["width"],
            pixel_data["height"]
        )
        
        pixel_data["frames"] = compressed_frames
        pixel_data["compressed"] = True
        
        # Save
        output_path = output_dir / f"animation-{anim_num}-pixels.json"
        with open(output_path, 'w') as f:
            json.dump(pixel_data, f, separators=(',', ':'))
        
        file_size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"  ✅ Saved: {file_size_mb:.1f} MB")
    
    print(f"\n🎯 All animations extracted!")

if __name__ == "__main__":
    main()

