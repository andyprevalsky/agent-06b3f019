#!/usr/bin/env python3
"""
Convert video to ASCII art animation based on luminescence.
Similar to early Midjourney's ASCII loading animation.
"""

import cv2
import numpy as np
import json
from pathlib import Path

# ASCII characters ordered by luminance (darkest to brightest)
# More whitespace at the beginning for cleaner, more stable animation
ASCII_CHARS = "        ...:::;;;iii111tttfffLLLCCCGGG000888@@@"
# For more detail, use: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"

def get_video_path():
    """Find the hero animation video."""
    base_dir = Path(__file__).parent.parent
    video_path = base_dir / "public" / "navi-hero-animation.webm"
    
    if not video_path.exists():
        # Try dist folder
        video_path = base_dir / "dist" / "navi-hero-animation.webm"
    
    if not video_path.exists():
        raise FileNotFoundError(f"Could not find navi-hero-animation.webm in public or dist folders")
    
    return video_path

def resize_frame(frame, new_width=60):
    """Resize frame while maintaining aspect ratio."""
    height, width = frame.shape
    aspect_ratio = height / width
    new_height = int(aspect_ratio * new_width * 0.55)  # 0.55 to account for character aspect ratio
    resized = cv2.resize(frame, (new_width, new_height))
    return resized

def frame_to_ascii(frame, ascii_chars=ASCII_CHARS):
    """Convert a grayscale frame to ASCII art based on luminescence."""
    ascii_frame = []
    
    for row in frame:
        ascii_row = ""
        for pixel_value in row:
            # Map pixel value (0-255) to ASCII character
            char_index = int(pixel_value / 255 * (len(ascii_chars) - 1))
            ascii_row += ascii_chars[char_index]
        ascii_frame.append(ascii_row)
    
    return "\n".join(ascii_frame)

def extract_frames(video_path, num_frames=None, width=50):
    """Extract frames from video and convert to ASCII."""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {video_path}")
    
    # Get video properties
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    
    print(f"Video: {total_frames} frames @ {fps} FPS")
    
    # Use all frames if num_frames is None
    if num_frames is None:
        num_frames = total_frames
        frame_indices = list(range(total_frames))
        print(f"Using ALL {total_frames} frames")
    else:
        # Calculate frame indices to extract
        frame_indices = np.linspace(0, total_frames - 1, num_frames, dtype=int)
    
    ascii_frames = []
    
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        
        if not ret:
            print(f"Warning: Could not read frame {idx}")
            continue
        
        # Convert to grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Apply Gaussian blur to reduce noise
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        
        # Enhance contrast
        gray = cv2.equalizeHist(gray)
        
        # Resize for ASCII
        resized = resize_frame(gray, new_width=width)
        
        # Convert to ASCII
        ascii_art = frame_to_ascii(resized)
        ascii_frames.append(ascii_art)
        
        print(f"Processed frame {len(ascii_frames)}/{num_frames}")
    
    cap.release()
    
    return ascii_frames

def save_frames(frames, output_path):
    """Save ASCII frames to JSON file."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(frames, f, indent=2)
    
    print(f"\nSaved {len(frames)} frames to {output_path}")

def main():
    try:
        # Find video
        video_path = get_video_path()
        print(f"Found video: {video_path}")
        
        # Extract and convert frames
        print("\nExtracting frames...")
        ascii_frames = extract_frames(
            video_path,
            num_frames=None,  # Use ALL frames from the video
            width=50          # Width in characters
        )
        
        # Save to JSON
        output_path = Path(__file__).parent.parent / "src" / "components" / "terminal" / "ascii-frames.json"
        save_frames(ascii_frames, output_path)
        
        print("\n✅ ASCII animation created successfully!")
        print(f"Preview of first frame:\n")
        print(ascii_frames[0])
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

