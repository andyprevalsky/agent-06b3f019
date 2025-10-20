#!/usr/bin/env python3
"""
Extract pixel-perfect frames with deblurring and edge sharpening.
Uses nearest-neighbor scaling then applies post-processing to make crisp edges.
"""

import cv2
import numpy as np
import json
from pathlib import Path

def sharpen_frame(frame):
    """
    Post-process frame to remove blur and create crisp edges.
    - Threshold semi-transparent pixels to solid or transparent
    - Sharpen edges
    - Make circles actually circular
    """
    # Create a copy to work with
    frame_sharp = frame.copy()
    
    # Enhance contrast dramatically
    frame_lab = cv2.cvtColor(frame_sharp, cv2.COLOR_RGB2LAB)
    l, a, b = cv2.split(frame_lab)
    
    # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to L channel
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    
    frame_lab = cv2.merge([l, a, b])
    frame_sharp = cv2.cvtColor(frame_lab, cv2.COLOR_LAB2RGB)
    
    # Apply bilateral filter to smooth colors while preserving edges
    frame_sharp = cv2.bilateralFilter(frame_sharp, 5, 50, 50)
    
    # Sharpen using unsharp mask
    gaussian = cv2.GaussianBlur(frame_sharp, (0, 0), 2.0)
    frame_sharp = cv2.addWeighted(frame_sharp, 2.5, gaussian, -1.5, 0)
    
    # Quantize colors to reduce gradients and create crisp edges
    # This removes semi-transparent/blurry pixels
    quantize_levels = 16  # Reduce to 16 levels per channel
    frame_sharp = (frame_sharp // (256 // quantize_levels)) * (256 // quantize_levels)
    
    # Apply edge detection and enhancement
    gray = cv2.cvtColor(frame_sharp, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    
    # Dilate edges slightly to make them more prominent
    kernel = np.ones((2, 2), np.uint8)
    edges = cv2.dilate(edges, kernel, iterations=1)
    
    # Apply edges back to the image (darken edges)
    for i in range(3):
        frame_sharp[:, :, i] = np.where(edges > 0, 
                                        frame_sharp[:, :, i] * 0.3,  # Darken edges
                                        frame_sharp[:, :, i])
    
    # Final threshold to remove any remaining semi-transparent artifacts
    # Push colors to extremes - either fully background or fully foreground
    gray = cv2.cvtColor(frame_sharp, cv2.COLOR_RGB2GRAY)
    
    # Find the most common colors (background)
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    bg_color = np.argmax(hist)
    
    # Threshold: pixels close to background → exactly background
    threshold_range = 30
    mask = np.abs(gray - bg_color) < threshold_range
    for i in range(3):
        frame_sharp[:, :, i] = np.where(mask, bg_color, frame_sharp[:, :, i])
    
    return frame_sharp.astype(np.uint8)

def extract_pixels_sharp(video_path, target_size=(143, 143), crop_percent=0.05):
    """
    Extract frames with nearest-neighbor scaling then sharpen to remove blur.
    
    Args:
        video_path: Path to the video file
        target_size: Target size - should match tile size for no additional scaling
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
    print(f"Target size: {target_size[0]}×{target_size[1]}")
    print(f"Processing: Nearest-neighbor → Deblur → Sharpen → Crisp edges")
    
    frames_data = []
    
    for frame_idx in range(total_frames):
        ret, frame = cap.read()
        
        if not ret:
            print(f"Warning: Could not read frame {frame_idx}")
            break
        
        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Crop
        if crop_percent > 0:
            crop_x = int(width * crop_percent)
            crop_y = int(height * crop_percent)
            frame_rgb = frame_rgb[crop_y:height-crop_y, crop_x:width-crop_x]
        
        # Resize using nearest neighbor (least blur)
        frame_resized = cv2.resize(frame_rgb, target_size, interpolation=cv2.INTER_NEAREST)
        
        # Apply sharpening and deblurring
        frame_sharp = sharpen_frame(frame_resized)
        
        # Flatten to [r,g,b,r,g,b,...]
        flat_pixels = frame_sharp.flatten().tolist()
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
        "width": target_size[0],
        "height": target_size[1],
        "format": "flat_rgb",
        "description": "Crisp pixel-perfect extraction: nearest-neighbor + deblurring + edge sharpening",
        "frames": frames_data
    }
    
    return output_data

def compute_delta_frames(frames_data, width, height):
    """
    Compress frames using delta encoding.
    Only store pixels that changed from the previous frame.
    """
    print("\n🗜️  Computing delta compression...")
    
    compressed_frames = []
    pixels_per_frame = width * height * 3  # RGB
    threshold = 10  # Pixels must differ by at least this much
    
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
                
                # Check if pixel changed significantly
                if (abs(r - pr) > threshold or 
                    abs(g - pg) > threshold or 
                    abs(b - pb) > threshold):
                    # Store: [pixel_index, r, g, b]
                    deltas.append([i // 3, r, g, b])
            
            # If too many changes (>50%), store as full frame
            if len(deltas) > (width * height * 0.5):
                compressed_frames.append({
                    "type": "full",
                    "pixels": frame_pixels
                })
                print(f"Frame {frame_idx}: Full frame (too many changes)")
            else:
                compressed_frames.append({
                    "type": "delta",
                    "base": frame_idx - 1,
                    "deltas": deltas
                })
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
    print(f"\n🔄 Extracting with deblurring and sharpening...\n")
    
    # Extract with sharpening (target size = tile size for no additional scaling)
    pixel_data = extract_pixels_sharp(
        video_path,
        target_size=(143, 143),  # Match tile size exactly
        crop_percent=0.05
    )
    
    # Compute delta compression
    compressed_frames = compute_delta_frames(
        pixel_data["frames"],
        pixel_data["width"],
        pixel_data["height"]
    )
    
    # Replace frames with compressed version
    pixel_data["frames"] = compressed_frames
    pixel_data["compressed"] = True
    pixel_data["description"] = "Crisp pixels with delta compression for memory efficiency"
    
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
    print(f"\n🎯 Pixels are CRISP with delta compression!")

if __name__ == "__main__":
    main()

