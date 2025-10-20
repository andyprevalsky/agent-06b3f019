#!/usr/bin/env python3
"""
Extract CLEAN pixel-perfect frames with ONLY 2 COLORS.
Clean geometric shapes (circles, squares, rectangles) with NO jagged edges.
"""

import cv2
import numpy as np
import json
from pathlib import Path

def clean_frame_to_two_colors(frame):
    """
    Convert frame to EXACTLY 2 colors with clean geometric shapes.
    - Binary thresholding (only foreground or background)
    - Morphological operations to clean up shapes
    - Circle detection and redrawing for perfect circles
    - Rectangle detection and redrawing for perfect rectangles
    """
    # Convert to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    
    # Apply Gaussian blur to reduce noise before thresholding
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Otsu's thresholding - automatically finds optimal threshold
    # This gives us a binary image (only 0 or 255)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    # Morphological operations to clean up shapes
    # Close small holes
    kernel_close = np.ones((3, 3), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel_close, iterations=2)
    
    # Remove small noise
    kernel_open = np.ones((3, 3), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel_open, iterations=2)
    
    # Smooth edges - dilate then erode to make circles/rectangles cleaner
    kernel_smooth = np.ones((2, 2), np.uint8)
    binary = cv2.dilate(binary, kernel_smooth, iterations=1)
    binary = cv2.erode(binary, kernel_smooth, iterations=1)
    
    # Detect and redraw circles for perfect circular shapes
    circles = cv2.HoughCircles(
        binary, 
        cv2.HOUGH_GRADIENT, 
        dp=1, 
        minDist=20,
        param1=50, 
        param2=15, 
        minRadius=5, 
        maxRadius=50
    )
    
    # Create output with perfect shapes
    clean_binary = binary.copy()
    
    if circles is not None:
        circles = np.uint16(np.around(circles))
        for circle in circles[0, :]:
            center = (circle[0], circle[1])
            radius = circle[2]
            # Redraw as perfect circle
            cv2.circle(clean_binary, center, radius, 255, -1)  # Filled circle
            # Clear area around it first to ensure clean edges
            cv2.circle(clean_binary, center, radius + 2, 0, 2)
            cv2.circle(clean_binary, center, radius, 255, -1)
    
    # Detect and clean up rectangles
    contours, _ = cv2.findContours(clean_binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    for contour in contours:
        # Approximate contour to polygon
        epsilon = 0.02 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        
        # If it's roughly rectangular (4 corners)
        if len(approx) == 4:
            # Get bounding rectangle
            x, y, w, h = cv2.boundingRect(contour)
            # Redraw as perfect rectangle
            cv2.rectangle(clean_binary, (x, y), (x + w, y + h), 255, -1)
    
    # Determine the two colors from original frame
    # Get median colors for foreground and background
    foreground_pixels = frame[binary == 255]
    background_pixels = frame[binary == 0]
    
    if len(foreground_pixels) > 0:
        fg_color = np.median(foreground_pixels, axis=0).astype(np.uint8)
    else:
        fg_color = np.array([0, 0, 0], dtype=np.uint8)
    
    if len(background_pixels) > 0:
        bg_color = np.median(background_pixels, axis=0).astype(np.uint8)
    else:
        bg_color = np.array([255, 255, 255], dtype=np.uint8)
    
    # Create output frame with EXACTLY 2 colors
    output = np.zeros_like(frame)
    output[clean_binary == 255] = fg_color
    output[clean_binary == 0] = bg_color
    
    return output

def extract_pixels_clean(video_path, target_size=(143, 143), crop_percent=0.05):
    """
    Extract frames with ONLY 2 colors and clean geometric shapes.
    
    Args:
        video_path: Path to the video file
        target_size: Target size - should match tile size
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
    print(f"Processing: 2 COLORS ONLY + Clean geometric shapes")
    
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
        
        # Resize using LANCZOS (high quality for initial resize)
        frame_resized = cv2.resize(frame_rgb, target_size, interpolation=cv2.INTER_LANCZOS4)
        
        # Clean to exactly 2 colors with perfect shapes
        frame_clean = clean_frame_to_two_colors(frame_resized)
        
        # Flatten to [r,g,b,r,g,b,...]
        flat_pixels = frame_clean.flatten().tolist()
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
        "description": "Clean extraction: ONLY 2 colors per frame, perfect geometric shapes (circles, squares, rectangles)",
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
    threshold = 5  # Pixels must differ by at least this much
    
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
                if (frame_idx + 1) % 50 == 0:  # Print every 50 frames
                    print(f"Frame {frame_idx}: Delta ({len(deltas)} changes, {savings:.1f}% savings)")
    
    return compressed_frames

def main():
    # Input video path
    video_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1.mov"
    
    if not video_path.exists():
        print(f"❌ Video not found: {video_path}")
        return
    
    print(f"📹 Input: {video_path}")
    print(f"\n🔄 Extracting with 2-COLOR CLEAN extraction...\n")
    
    # Extract with clean 2-color processing
    pixel_data = extract_pixels_clean(
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
    print(f"\n🎯 CLEAN: Only 2 colors + perfect geometric shapes!")

if __name__ == "__main__":
    main()

