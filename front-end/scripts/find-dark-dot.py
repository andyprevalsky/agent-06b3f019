#!/usr/bin/env python3
"""
Find DARK circular dot in video frame.
"""

import cv2
import numpy as np
from pathlib import Path

def find_dark_dot(frame):
    """
    Find dark circular dot in frame.
    """
    # Convert to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Apply Gaussian blur
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # INVERT the image so dark becomes bright for circle detection
    inverted = 255 - blurred
    
    # Try circle detection on inverted image (dark circles become bright)
    print("\n🔍 Looking for DARK circular dot...")
    circles = cv2.HoughCircles(
        inverted,
        cv2.HOUGH_GRADIENT,
        dp=1,
        minDist=100,  # Dots should be far apart
        param1=50,
        param2=20,    # Lower threshold to find smaller circles
        minRadius=10,  # Minimum radius
        maxRadius=80   # Maximum radius
    )
    
    if circles is not None:
        circles = np.round(circles[0, :]).astype("int")
        print(f"  Found {len(circles)} dark circle(s):")
        for i, (x, y, r) in enumerate(circles):
            # Check if it's actually dark (not edge artifacts)
            if x < 50 or y < 50 or x > frame.shape[1] - 50 or y > frame.shape[0] - 50:
                print(f"    Circle {i+1}: ({x}, {y}), radius={r} - SKIPPED (too close to edge)")
                continue
            
            # Check average darkness in the circle region
            mask = np.zeros(gray.shape, dtype=np.uint8)
            cv2.circle(mask, (x, y), r, 255, -1)
            mean_val = cv2.mean(gray, mask=mask)[0]
            print(f"    Circle {i+1}: ({x}, {y}), radius={r}, darkness={255-mean_val:.1f}/255")
            
            # Return the first valid dark circle (darkest)
            if mean_val < 200:  # Must be reasonably dark
                return (x, y, r, mean_val)
    
    # Fallback: Find darkest region manually
    print("\n  No circles found, finding darkest region...")
    
    # Mask out edges (they can be black artifacts)
    mask = np.ones(gray.shape, dtype=np.uint8) * 255
    mask[0:50, :] = 0
    mask[-50:, :] = 0
    mask[:, 0:50] = 0
    mask[:, -50:] = 0
    
    # Find local minima (dark spots)
    masked = cv2.bitwise_and(gray, gray, mask=mask)
    min_val = cv2.minMaxLoc(masked, mask=mask)
    
    darkest_x, darkest_y = min_val[2]
    darkest_val = min_val[0]
    
    print(f"  Darkest point: ({darkest_x}, {darkest_y}), value={darkest_val}")
    
    return (darkest_x, darkest_y, 20, darkest_val)  # Assume radius of 20

def visualize_detection(frame, dot_info):
    """Create debug visualization."""
    output = frame.copy()
    height, width = frame.shape[:2]
    
    # Draw frame center
    center_x, center_y = width // 2, height // 2
    cv2.line(output, (center_x - 50, center_y), (center_x + 50, center_y), (0, 255, 0), 2)
    cv2.line(output, (center_x, center_y - 50), (center_x, center_y + 50), (0, 255, 0), 2)
    cv2.putText(output, f"Frame Center ({center_x},{center_y})", 
                (center_x + 10, center_y - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    
    if dot_info:
        x, y, r, darkness = dot_info
        # Draw detected dot
        cv2.circle(output, (x, y), r, (0, 0, 255), 3)
        cv2.circle(output, (x, y), 5, (0, 0, 255), -1)
        cv2.putText(output, f"DOT ({x},{y})", 
                    (x + r + 10, y), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        
        # Draw line to center
        cv2.line(output, (x, y), (center_x, center_y), (255, 0, 255), 1)
        offset_x = x - center_x
        offset_y = y - center_y
        mid_x = (x + center_x) // 2
        mid_y = (y + center_y) // 2
        cv2.putText(output, f"Offset: ({offset_x},{offset_y})", 
                    (mid_x, mid_y - 10), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 255), 2)
    
    return output

def crop_and_center_video(input_path, output_path, dot_x, dot_y):
    """Crop video to center the dot."""
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {input_path}")
        return
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Output will be square, using the smaller dimension
    output_size = min(width, height)
    
    # Calculate crop region - center EXACTLY on the dot
    # The dot should end up at (output_size//2, output_size//2)
    crop_x = dot_x - output_size // 2
    crop_y = dot_y - output_size // 2
    
    # Check if crop is possible (dot might be too close to edge)
    if crop_x < 0 or crop_y < 0 or crop_x + output_size > width or crop_y + output_size > height:
        # Need to reduce output size to center the dot
        # Calculate maximum size we can use while keeping dot centered
        max_left = dot_x
        max_right = width - dot_x
        max_top = dot_y
        max_bottom = height - dot_y
        
        # Use the smallest distance (doubled) as the output size
        output_size = min(max_left, max_right, max_top, max_bottom) * 2
        
        # Recalculate crop region
        crop_x = dot_x - output_size // 2
        crop_y = dot_y - output_size // 2
        
        print(f"   ⚠️  Adjusted output size to {output_size}×{output_size} to center dot")
    
    # Where will the dot be in the output?
    out_dot_x = dot_x - crop_x
    out_dot_y = dot_y - crop_y
    
    print(f"\n📐 Cropping video:")
    print(f"   Input: {width}×{height}")
    print(f"   Dot at: ({dot_x}, {dot_y})")
    print(f"   Output: {output_size}×{output_size}")
    print(f"   Crop region: x={crop_x}, y={crop_y}")
    print(f"   Dot will be at: ({out_dot_x}, {out_dot_y}) in output")
    print(f"   Output center: ({output_size//2}, {output_size//2})")
    print(f"   Perfect centering: {out_dot_x == output_size//2 and out_dot_y == output_size//2}")
    
    # Setup output writer
    fourcc = cv2.VideoWriter_fourcc(*'avc1')  # H.264 codec for .mov
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (output_size, output_size))
    
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Crop frame
        cropped = frame[crop_y:crop_y+output_size, crop_x:crop_x+output_size]
        out.write(cropped)
        
        frame_count += 1
        if frame_count % 100 == 0:
            print(f"   Processed {frame_count}/{total_frames} frames")
    
    cap.release()
    out.release()
    
    print(f"\n✅ Saved centered video: {output_path.name}")

def main():
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1.mov"
    output_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1-centered.mov"
    
    if not input_path.exists():
        print(f"❌ Video not found: {input_path}")
        return
    
    cap = cv2.VideoCapture(str(input_path))
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print("❌ Could not read first frame")
        return
    
    print(f"📹 Video: {frame.shape[1]}×{frame.shape[0]}")
    
    # Find the dot
    dot_info = find_dark_dot(frame)
    
    if dot_info:
        x, y, r, darkness = dot_info
        print(f"\n✅ DARK DOT FOUND:")
        print(f"   Position: ({x}, {y})")
        print(f"   Radius: {r}px")
        print(f"   Darkness: {255-darkness:.1f}/255")
        
        # Save visualization
        vis = visualize_detection(frame, dot_info)
        vis_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-1-dot-found.jpg"
        cv2.imwrite(str(vis_path), vis)
        print(f"\n💾 Visualization saved: animation-1-dot-found.jpg")
        
        # Crop and center the video
        crop_and_center_video(input_path, output_path, x, y)
        
        print(f"\n🎯 Done! Now replace animation-1.mov with animation-1-centered.mov")
        
        return (x, y)
    else:
        print("\n❌ Could not find dark dot")
        return None

if __name__ == "__main__":
    main()

