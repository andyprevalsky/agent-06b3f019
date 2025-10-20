#!/usr/bin/env python3
"""
Check the actual background color in the animation videos.
"""

import cv2
import numpy as np
from pathlib import Path

def analyze_background_color(video_path):
    """Analyze the background color in the video."""
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {video_path}")
        return
    
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print(f"❌ Could not read frame")
        return
    
    # Convert to RGB for easier reading
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    
    height, width = frame_rgb.shape[:2]
    center_x, center_y = width // 2, height // 2
    
    # Sample background pixels (corners and edges, away from dot)
    samples = []
    
    # Corners (20x20 patches)
    samples.append(frame_rgb[0:20, 0:20].mean(axis=(0, 1)))
    samples.append(frame_rgb[0:20, -20:].mean(axis=(0, 1)))
    samples.append(frame_rgb[-20:, 0:20].mean(axis=(0, 1)))
    samples.append(frame_rgb[-20:, -20:].mean(axis=(0, 1)))
    
    # Edge centers (avoiding dot in middle)
    samples.append(frame_rgb[0:20, center_x-10:center_x+10].mean(axis=(0, 1)))
    samples.append(frame_rgb[-20:, center_x-10:center_x+10].mean(axis=(0, 1)))
    samples.append(frame_rgb[center_y-10:center_y+10, 0:20].mean(axis=(0, 1)))
    samples.append(frame_rgb[center_y-10:center_y+10, -20:].mean(axis=(0, 1)))
    
    # Average all samples
    avg_color = np.mean(samples, axis=0)
    r, g, b = avg_color
    
    print(f"\n📹 {video_path.name}")
    print(f"   Background color (RGB): ({int(r)}, {int(g)}, {int(b)})")
    print(f"   Hex: #{int(r):02x}{int(g):02x}{int(b):02x}")
    
    # Check if it's close to various standards
    if r > 240 and g > 240 and b > 240:
        print(f"   ✓ Very bright (white-ish)")
    elif abs(r - g) < 20 and abs(g - b) < 20:
        print(f"   ✓ Grayscale")
    else:
        print(f"   ⚠️  Has color tint!")
        if g > r and g > b:
            print(f"      GREEN tint detected (G is highest)")
        elif r > g and r > b:
            print(f"      RED tint detected (R is highest)")
        elif b > r and b > g:
            print(f"      BLUE tint detected (B is highest)")
    
    return (int(r), int(g), int(b))

def main():
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    
    print("🎨 Checking background colors...\n")
    
    colors = []
    for anim_num in [1, 2, 3, 4]:
        input_path = base_dir / f"animation-{anim_num}.mov"
        if input_path.exists():
            color = analyze_background_color(input_path)
            if color:
                colors.append(color)
    
    if colors:
        avg = np.mean(colors, axis=0)
        print(f"\n📊 Average background across all animations:")
        print(f"   RGB: ({int(avg[0])}, {int(avg[1])}, {int(avg[2])})")
        print(f"   Hex: #{int(avg[0]):02x}{int(avg[1]):02x}{int(avg[2]):02x}")
        print(f"\n💡 Suggested color threshold:")
        print(f"   Replace pixels where R >= {int(avg[0])-5}, G >= {int(avg[1])-5}, B >= {int(avg[2])-5}")

if __name__ == "__main__":
    main()

