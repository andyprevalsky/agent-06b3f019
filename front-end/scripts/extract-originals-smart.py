#!/usr/bin/env python3
"""
Extract animations from originals with smart trimming analysis
This finds the correct start/end frames directly from originals
"""
import cv2
import numpy as np
import json
from pathlib import Path

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
    
    print(f"  Analyzing {total_frames} frames...")
    
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
            start_frame = max(0, i)  # Frame i+1 in video (since differences start at frame 1)
            break
    
    if start_frame is None:
        print(f"  ⚠️  No start frame found!")
        return None, None
    
    # Find end frame (last significant change, working backwards)
    end_frame = None
    for i in range(len(differences) - 1, start_frame, -1):
        if differences[i] > threshold:
            end_frame = min(len(differences), i + 17)  # Add buffer
            break
    
    if end_frame is None:
        end_frame = len(differences)
    
    frame_count = end_frame - start_frame
    
    print(f"  Baseline: {baseline:.3f}, Threshold: {threshold:.3f}")
    print(f"  Start: frame {start_frame}, End: frame {end_frame}")
    print(f"  Total frames: {frame_count}")
    
    return start_frame, frame_count

def extract_animation(anim_id):
    """Extract animation from original video with smart trimming"""
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
    print(f"  Resting dot position (frame 0): ({dot_x}, {dot_y})")
    
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
    
    print(f"  Crop region (centered on resting dot): ({crop_x1}, {crop_y1}) to ({crop_x2}, {crop_y2})")
    
    cap.release()
    
    # STEP 2: Analyze to find correct trim points
    start_frame, frame_count = analyze_trimming(input_path)
    
    if start_frame is None:
        print(f"❌ Could not determine trimming for animation-{anim_id}")
        return
    
    print(f"  Extracting {frame_count} frames starting at frame {start_frame}...")
    
    # STEP 3: Extract frames with the crop calculated from resting position
    cap = cv2.VideoCapture(str(input_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    frames_data = []
    base_frame = None
    
    for i in range(frame_count):
        ret, frame = cap.read()
        if not ret:
            print(f"⚠️  Only got {i} frames")
            break
        
        # Crop to center dot
        cropped = frame[crop_y1:crop_y2, crop_x1:crop_x2]
        
        if cropped.shape[0] != 222 or cropped.shape[1] != 222:
            print(f"⚠️  Frame {i} is {cropped.shape[1]}×{cropped.shape[0]}, expected 222×222")
            continue
        
        # Convert to RGB and flatten
        rgb = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
        pixels = rgb.flatten().tolist()
        
        # Delta compression
        if i == 0:
            base_frame = pixels
            frames_data.append({
                "type": "full",
                "pixels": pixels
            })
        else:
            # Compute delta
            deltas = []
            for idx in range(0, len(pixels), 3):
                r, g, b = pixels[idx], pixels[idx+1], pixels[idx+2]
                base_r, base_g, base_b = base_frame[idx], base_frame[idx+1], base_frame[idx+2]
                
                if r != base_r or g != base_g or b != base_b:
                    deltas.append([idx // 3, r, g, b])
            
            frames_data.append({
                "type": "delta",
                "base": 0,
                "deltas": deltas
            })
    
    cap.release()
    
    # Save JSON
    output_data = {
        "id": f"animation-{anim_id}",
        "fps": fps,
        "duration_ms": int((frame_count / fps) * 1000),
        "frame_count": len(frames_data),
        "width": 222,
        "height": 222,
        "format": "RGBA",
        "description": f"Animation {anim_id} extracted from original with smart trimming",
        "compressed": True,
        "frames": frames_data
    }
    
    output_path = Path(__file__).parent.parent / "src" / "lib" / f"animation-{anim_id}-pixels.json"
    with open(output_path, 'w') as f:
        json.dump(output_data, f)
    
    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  ✅ Saved: {file_size_mb:.1f} MB\n")

if __name__ == "__main__":
    print("🎬 Extracting animations from originals with SMART TRIMMING\n")
    
    for anim_id in [1, 2, 3, 4]:
        extract_animation(anim_id)
    
    print("🎯 All animations extracted!")

