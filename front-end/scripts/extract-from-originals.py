#!/usr/bin/env python3
"""
Extract animations directly from original videos with parameters
This avoids compression blur from intermediate re-encoding
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

def extract_animation(anim_id, start_frame, frame_count):
    """Extract animation from original video"""
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    input_path = base_dir / f"animation-{anim_id}-original.mov"
    
    cap = cv2.VideoCapture(str(input_path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    orig_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    # Read the first frame we'll use (after trimming)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    ret, first_frame = cap.read()
    if not ret:
        print(f"❌ Could not read frame {start_frame}")
        return
    
    # Detect dot position in this frame
    dot_x, dot_y = detect_dot_position(first_frame)
    
    # Calculate crop to center the dot at 222×222
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
    
    print(f"📹 animation-{anim_id}-original.mov")
    print(f"  Original: {orig_width}×{orig_height}")
    print(f"  Dot at frame {start_frame}: ({dot_x}, {dot_y})")
    print(f"  Crop region: ({crop_x1}, {crop_y1}) to ({crop_x2}, {crop_y2})")
    print(f"  Extracting {frame_count} frames starting at frame {start_frame}")
    
    # Now extract all frames
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
        
        # Apply 5% edge crop
        crop_pixels = int(222 * 0.05)
        final = cropped[crop_pixels:-crop_pixels, crop_pixels:-crop_pixels]
        
        if final.shape[0] != 200 or final.shape[1] != 200:
            print(f"⚠️  Frame {i} is {final.shape[1]}×{final.shape[0]}, expected 200×200")
            continue
        
        # Convert to RGB and flatten
        rgb = cv2.cvtColor(final, cv2.COLOR_BGR2RGB)
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
        "width": 200,
        "height": 200,
        "format": "RGBA",
        "description": f"Animation {anim_id} extracted from original",
        "compressed": True,
        "frames": frames_data
    }
    
    output_path = Path(__file__).parent.parent / "src" / "lib" / f"animation-{anim_id}-pixels.json"
    with open(output_path, 'w') as f:
        json.dump(output_data, f)
    
    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  ✅ Saved: {file_size_mb:.1f} MB\n")

if __name__ == "__main__":
    print("🎬 Extracting animations from ORIGINAL videos (no re-encoding blur)\n")
    
    # Parameters from our pipeline
    animations = [
        (1, 220, 446),
        (2, 100, 420),
        (3, 119, 466),
        (4, 89, 597),
    ]
    
    for anim_id, start_frame, frame_count in animations:
        extract_animation(anim_id, start_frame, frame_count)
    
    print("🎯 All animations extracted from originals!")

