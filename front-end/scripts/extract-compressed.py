#!/usr/bin/env python3
"""
Extract animations with aggressive compression:
- 2-color quantization (background + animation color)
- Previous-frame deltas for minimal storage
- Keyframes every 60 frames for seeking
"""
import cv2
import numpy as np
import json
from pathlib import Path
from collections import Counter

def detect_dot_position(frame):
    """Detect the dark dot position in a frame"""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    
    # Mask edges
    mask = np.ones(gray.shape, dtype=np.uint8) * 255
    mask[0:50, :] = 0
    mask[-50:, :] = 0
    mask[:, 0:50] = 0
    mask[:, -50:] = 0
    
    masked = cv2.bitwise_and(gray, gray, mask=mask)
    min_val = cv2.minMaxLoc(masked, mask=mask)
    dot_x, dot_y = min_val[2]
    
    return dot_x, dot_y

def analyze_trimming(video_path):
    """Find start and end frames using center circle change detection"""
    cap = cv2.VideoCapture(str(video_path))
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Define center circle (25% of width)
    center_x, center_y = width // 2, height // 2
    radius = int(min(width, height) * 0.25)
    
    # Create circular mask
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.circle(mask, (center_x, center_y), radius, 255, -1)
    
    # Calculate frame-to-frame differences in center circle
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    ret, prev_frame = cap.read()
    if not ret:
        return None, None
    
    prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    prev_center = cv2.bitwise_and(prev_gray, prev_gray, mask=mask)
    
    differences = []
    
    for i in range(1, total_frames):
        ret, frame = cap.read()
        if not ret:
            break
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        center = cv2.bitwise_and(gray, gray, mask=mask)
        
        # Calculate mean absolute difference in center circle only
        diff = np.abs(center.astype(float) - prev_center.astype(float))
        mean_diff = np.mean(diff[mask > 0])
        differences.append(mean_diff)
        
        prev_center = center
    
    cap.release()
    
    # Find baseline (median of first 60 frames)
    baseline = np.median(differences[:60])
    threshold = baseline + 0.05
    
    # Find start frame (first significant change)
    start_frame = None
    for i, diff in enumerate(differences):
        if diff > threshold:
            start_frame = max(0, i)
            break
    
    if start_frame is None:
        return None, None
    
    # Find end frame (last significant change, working backwards)
    end_frame = None
    for i in range(len(differences) - 1, start_frame, -1):
        if differences[i] > threshold:
            end_frame = min(len(differences), i + 17)
            break
    
    if end_frame is None:
        end_frame = len(differences)
    
    frame_count = end_frame - start_frame
    
    return start_frame, frame_count

def quantize_to_4_colors(frame):
    """Quantize frame to exactly 4 colors: background + dark + medium + light"""
    # Reshape to list of pixels
    pixels = frame.reshape(-1, 3).astype(np.float32)
    
    # K-means clustering to find 4 colors
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(pixels, 4, None, criteria, 10, cv2.KMEANS_PP_CENTERS)
    
    # Sort colors by frequency (most common = background)
    label_counts = Counter(labels.flatten())
    sorted_labels = sorted(label_counts.items(), key=lambda x: x[1], reverse=True)
    
    # Assign labels by frequency: 0=background (most), 1=second, 2=third, 3=least
    color_labels = [sorted_labels[i][0] for i in range(4)]
    colors = [centers[label].astype(np.uint8) for label in color_labels]
    
    # Create quantized frame
    quantized = np.zeros_like(frame)
    labels_reshaped = labels.reshape(frame.shape[:2])
    for i, label in enumerate(color_labels):
        quantized[labels_reshaped == label] = colors[i]
    
    return quantized, colors[0], colors[1], colors[2], colors[3]

def extract_animation(anim_id):
    """Extract animation with aggressive compression"""
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    input_path = base_dir / f"animation-{anim_id}-original.mov"
    
    print(f"📹 animation-{anim_id}-original.mov")
    
    cap = cv2.VideoCapture(str(input_path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    orig_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    # STEP 1: Detect dot at RESTING POSITION (frame 0) for centering
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    ret, first_frame = cap.read()
    if not ret:
        print(f"❌ Could not read frame 0")
        cap.release()
        return
    
    # Detect dot position at resting position
    dot_x, dot_y = detect_dot_position(first_frame)
    
    # Calculate crop to center the dot at 222×222 based on RESTING position
    crop_size = 222
    crop_x1 = max(0, dot_x - crop_size // 2)
    crop_y1 = max(0, dot_y - crop_size // 2)
    crop_x2 = min(orig_width, crop_x1 + crop_size)
    crop_y2 = min(orig_height, crop_y1 + crop_size)
    
    # Adjust if we hit edges
    if crop_x2 - crop_x1 < crop_size:
        crop_x1 = crop_x2 - crop_size
    if crop_y2 - crop_y1 < crop_size:
        crop_y1 = crop_y2 - crop_size
    
    cap.release()
    
    # STEP 2: Analyze to find correct trim points
    start_frame, frame_count = analyze_trimming(input_path)
    
    if start_frame is None:
        print(f"❌ Could not determine trimming for animation-{anim_id}")
        return
    
    print(f"  Frames: {frame_count}, starting at {start_frame}")
    print(f"  Extracting with 4-color indexing and frame-to-frame deltas...")
    
    # STEP 3: Extract frames with aggressive compression
    cap = cv2.VideoCapture(str(input_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    frames_data = []
    prev_indices = None
    color0 = None  # Background (most common)
    color1 = None  # Second most common
    color2 = None  # Third most common
    color3 = None  # Least common
    
    for i in range(frame_count):
        ret, frame = cap.read()
        if not ret:
            break
        
        # Crop to center dot
        cropped = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        
        if cropped.shape[0] != 222 or cropped.shape[1] != 222:
            continue
        
        # Quantize to 4 colors (returns BGR from OpenCV)
        quantized, frame_c0, frame_c1, frame_c2, frame_c3 = quantize_to_4_colors(cropped)
        
        # Use first frame's colors as reference (convert BGR to RGB)
        if color0 is None:
            color0 = [int(frame_c0[2]), int(frame_c0[1]), int(frame_c0[0])]  # BGR -> RGB
            color1 = [int(frame_c1[2]), int(frame_c1[1]), int(frame_c1[0])]
            color2 = [int(frame_c2[2]), int(frame_c2[1]), int(frame_c2[0])]
            color3 = [int(frame_c3[2]), int(frame_c3[1]), int(frame_c3[0])]
        
        # Convert to RGB
        rgb = cv2.cvtColor(quantized, cv2.COLOR_BGR2RGB)
        
        # Convert to color indices (0, 1, 2, or 3) using nearest color matching
        color_indices = []
        for y in range(222):
            for x in range(222):
                pixel = rgb[y, x]
                r, g, b = int(pixel[0]), int(pixel[1]), int(pixel[2])
                
                # Find closest color using Euclidean distance
                distances = [
                    (r - color0[0])**2 + (g - color0[1])**2 + (b - color0[2])**2,
                    (r - color1[0])**2 + (g - color1[1])**2 + (b - color1[2])**2,
                    (r - color2[0])**2 + (g - color2[1])**2 + (b - color2[2])**2,
                    (r - color3[0])**2 + (g - color3[1])**2 + (b - color3[2])**2,
                ]
                
                # Assign to closest color index
                color_indices.append(distances.index(min(distances)))
        
        # Delta compression - only frame 0 is full, rest are deltas
        if i == 0:
            # First frame only - full color indices
            frames_data.append({
                "type": "full",
                "indices": color_indices
            })
        else:
            # Delta from previous frame - only store changed pixels
            deltas = []
            for pixel_idx in range(len(color_indices)):
                if color_indices[pixel_idx] != prev_indices[pixel_idx]:
                    deltas.append([pixel_idx, color_indices[pixel_idx]])
            
            frames_data.append({
                "type": "delta",
                "deltas": deltas
            })
        
        prev_indices = color_indices
    
    cap.release()
    
    # Save JSON
    output_data = {
        "id": f"animation-{anim_id}",
        "fps": fps,
        "duration_ms": int((frame_count / fps) * 1000),
        "frame_count": len(frames_data),
        "width": 222,
        "height": 222,
        "format": "indexed",
        "description": f"Animation {anim_id} - 4 color indexed with frame-to-frame deltas",
        "compressed": True,
        "colors": [color0, color1, color2, color3],
        "frames": frames_data
    }
    
    output_path = Path(__file__).parent.parent / "src" / "lib" / f"animation-{anim_id}-pixels.json"
    with open(output_path, 'w') as f:
        json.dump(output_data, f)
    
    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  ✅ Saved: {file_size_mb:.1f} MB\n")

if __name__ == "__main__":
    print("🎬 Extracting with MAXIMUM COMPRESSION\n")
    print("  - 4-color quantization (background + 3 animation shades)")
    print("  - Color indexing (0/1/2/3 instead of RGB)")
    print("  - Frame-to-frame deltas (only changed pixels)")
    print("  - No keyframes (only frame 0 is full)\n")
    
    for anim_id in [1, 2, 3, 4]:
        extract_animation(anim_id)
    
    print("🎯 All animations extracted!")

