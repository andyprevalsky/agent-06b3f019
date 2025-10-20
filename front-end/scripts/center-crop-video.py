#!/usr/bin/env python3
"""
Crop video to center the dot from the first frame.
"""

import cv2
import numpy as np
from pathlib import Path

def find_dot_center(frame):
    """
    Find the center of the dot in the frame using circle detection.
    Returns (x, y) coordinates of the dot center.
    """
    # Convert to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Apply Gaussian blur
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # Detect circles using Hough Circle Transform
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1,
        minDist=50,
        param1=50,
        param2=30,
        minRadius=5,
        maxRadius=100
    )
    
    if circles is not None:
        circles = np.round(circles[0, :]).astype("int")
        # Get the first (most prominent) circle
        x, y, r = circles[0]
        print(f"  Dot (circle) found at: ({x}, {y}) with radius {r}")
        return (x, y)
    
    print("⚠️  No circle found, trying contour detection...")
    
    # Fallback: Try finding darkest region with contours
    inverted = 255 - blurred
    _, thresh = cv2.threshold(inverted, 100, 255, cv2.THRESH_BINARY)
    
    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        print("⚠️  No dark dot found, trying brightest region...")
        # Try finding brightest region instead
        _, thresh = cv2.threshold(blurred, 200, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        print("❌ Could not find dot in frame")
        return None
    
    # Find the most circular contour (should be the dot)
    best_contour = None
    best_circularity = 0
    
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < 50:  # Skip very small contours
            continue
        perimeter = cv2.arcLength(contour, True)
        if perimeter == 0:
            continue
        circularity = 4 * np.pi * area / (perimeter * perimeter)
        if circularity > best_circularity:
            best_circularity = circularity
            best_contour = contour
    
    if best_contour is None:
        print("❌ Could not find circular dot")
        return None
    
    # Calculate moments to find precise center
    M = cv2.moments(best_contour)
    if M['m00'] == 0:
        return None
    
    cx = int(M['m10'] / M['m00'])
    cy = int(M['m01'] / M['m00'])
    
    print(f"  Dot (contour) found at: ({cx}, {cy}), circularity: {best_circularity:.2f}")
    
    return (cx, cy)

def crop_video_to_center_dot(input_path, output_path):
    """
    Crop video so the dot from the first frame is centered.
    """
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {input_path}")
        return
    
    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"📹 Input video: {width}×{height}, {total_frames} frames @ {fps} FPS")
    
    # Read first frame
    ret, first_frame = cap.read()
    if not ret:
        print("❌ Could not read first frame")
        cap.release()
        return
    
    # Find dot center
    dot_center = find_dot_center(first_frame)
    if dot_center is None:
        print("❌ Could not find dot, aborting")
        cap.release()
        return
    
    dot_x, dot_y = dot_center
    
    # Determine output size (use smaller dimension to ensure we can crop)
    output_size = min(width, height)
    
    # Calculate crop region - center it EXACTLY on the dot
    # The dot should be at (output_size/2, output_size/2) in the output
    crop_x = dot_x - output_size // 2
    crop_y = dot_y - output_size // 2
    
    # Check if crop region is within bounds
    if crop_x < 0 or crop_y < 0 or crop_x + output_size > width or crop_y + output_size > height:
        print(f"  ⚠️  Dot too close to edge, adjusting crop region...")
        # Clamp to valid region
        crop_x = max(0, min(crop_x, width - output_size))
        crop_y = max(0, min(crop_y, height - output_size))
        # Recalculate where dot will be in output
        out_dot_x = dot_x - crop_x
        out_dot_y = dot_y - crop_y
        print(f"  Dot will be at: ({out_dot_x}, {out_dot_y}) in output (center is {output_size//2}, {output_size//2})")
    else:
        print(f"  Dot will be centered at: ({output_size//2}, {output_size//2}) in output")
    
    print(f"  Crop region: x={crop_x}, y={crop_y}, size={output_size}×{output_size}")
    
    # Reset video to beginning
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    # Setup output video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (output_size, output_size))
    
    # Process all frames
    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Crop frame
        cropped = frame[crop_y:crop_y+output_size, crop_x:crop_x+output_size]
        
        # Write to output
        out.write(cropped)
        
        frame_count += 1
        if frame_count % 50 == 0:
            print(f"  Processed {frame_count}/{total_frames} frames")
    
    cap.release()
    out.release()
    
    print(f"✅ Saved centered video: {output_path}")
    print(f"   Output size: {output_size}×{output_size}")
    print(f"   Frames: {frame_count}")

def main():
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test.mp4"
    output_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test-centered.mp4"
    
    if not input_path.exists():
        print(f"❌ Video not found: {input_path}")
        return
    
    print(f"🔄 Centering dot in video...\n")
    crop_video_to_center_dot(input_path, output_path)
    print(f"\n🎯 Done! Centered video saved to: test-centered.mp4")

if __name__ == "__main__":
    main()

