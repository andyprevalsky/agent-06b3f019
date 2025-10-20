#!/usr/bin/env python3
"""
Debug script to visualize dot detection on first frame.
"""

import cv2
import numpy as np
from pathlib import Path

def visualize_dot_detection(input_path):
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print(f"❌ Could not open video: {input_path}")
        return
    
    # Read first frame
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print("❌ Could not read first frame")
        return
    
    height, width = frame.shape[:2]
    print(f"Frame size: {width}×{height}")
    
    # Convert to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # Try circle detection with various parameters
    print("\n🔍 Trying circle detection...")
    for param2 in [10, 15, 20, 25, 30, 40, 50]:
        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=50,
            param1=50,
            param2=param2,
            minRadius=5,
            maxRadius=100
        )
        
        if circles is not None:
            circles = np.round(circles[0, :]).astype("int")
            print(f"  param2={param2}: Found {len(circles)} circle(s)")
            for i, (x, y, r) in enumerate(circles[:3]):  # Show first 3
                print(f"    Circle {i+1}: center=({x}, {y}), radius={r}")
        else:
            print(f"  param2={param2}: No circles")
    
    # Visualize with multiple detection methods
    output = frame.copy()
    
    # Draw center crosshair
    center_x, center_y = width // 2, height // 2
    cv2.line(output, (center_x - 50, center_y), (center_x + 50, center_y), (0, 255, 0), 2)
    cv2.line(output, (center_x, center_y - 50), (center_x, center_y + 50), (0, 255, 0), 2)
    cv2.putText(output, f"Frame Center ({center_x},{center_y})", (center_x + 10, center_y - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    
    # Try to find darkest point
    min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(blurred)
    print(f"\nDarkest point: {min_loc} (value: {min_val})")
    print(f"Brightest point: {max_loc} (value: {max_val})")
    
    cv2.circle(output, min_loc, 10, (255, 0, 0), 2)
    cv2.putText(output, f"Darkest {min_loc}", (min_loc[0] + 15, min_loc[1]), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 1)
    
    cv2.circle(output, max_loc, 10, (0, 0, 255), 2)
    cv2.putText(output, f"Brightest {max_loc}", (max_loc[0] + 15, max_loc[1] + 20), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    
    # Save debug image
    output_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test-debug.jpg"
    cv2.imwrite(str(output_path), output)
    print(f"\n💾 Debug image saved to: test-debug.jpg")
    print(f"   Check this image to see what's being detected!")

def main():
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "test.mp4"
    
    if not input_path.exists():
        print(f"❌ Video not found: {input_path}")
        return
    
    visualize_dot_detection(input_path)

if __name__ == "__main__":
    main()

