#!/usr/bin/env python3
"""
Create visual debug image for animation-3.
"""

import cv2
import numpy as np
from pathlib import Path

def visualize_frame(frame, dot_pos, title="Debug"):
    """Create debug visualization with grid and markers."""
    output = frame.copy()
    height, width = frame.shape[:2]
    center_x, center_y = width // 2, height // 2
    
    # Draw frame center crosshair (GREEN)
    cv2.line(output, (center_x - 50, center_y), (center_x + 50, center_y), (0, 255, 0), 2)
    cv2.line(output, (center_x, center_y - 50), (center_x, center_y + 50), (0, 255, 0), 2)
    cv2.putText(output, f"Frame Center ({center_x},{center_y})", 
                (center_x + 10, center_y - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
    
    # Draw detected dot (RED)
    dot_x, dot_y = dot_pos
    cv2.circle(output, (dot_x, dot_y), 20, (0, 0, 255), 2)
    cv2.circle(output, (dot_x, dot_y), 5, (0, 0, 255), -1)
    cv2.putText(output, f"Detected Dot ({dot_x},{dot_y})", 
                (dot_x + 25, dot_y - 25), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
    
    # Draw line between them (MAGENTA)
    cv2.line(output, (center_x, center_y), (dot_x, dot_y), (255, 0, 255), 2)
    mid_x = (center_x + dot_x) // 2
    mid_y = (center_y + dot_y) // 2
    offset_x = dot_x - center_x
    offset_y = dot_y - center_y
    cv2.putText(output, f"Offset: ({offset_x},{offset_y})", 
                (mid_x, mid_y - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 2)
    
    # Draw grid (25% circle in center - BLUE)
    radius = int(min(width, height) * 0.25)
    cv2.circle(output, (center_x, center_y), radius, (255, 0, 0), 2)
    cv2.putText(output, "25% Detection Circle", 
                (center_x - radius, center_y - radius - 10), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)
    
    return output

def find_dot_center(frame):
    """Find dark dot center."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (9, 9), 2)
    
    # Mask out edges
    height, width = gray.shape
    mask = np.ones(gray.shape, dtype=np.uint8) * 255
    mask[0:50, :] = 0
    mask[-50:, :] = 0
    mask[:, 0:50] = 0
    mask[:, -50:] = 0
    
    # Find darkest point
    masked = cv2.bitwise_and(gray, gray, mask=mask)
    min_val = cv2.minMaxLoc(masked, mask=mask)
    
    darkest_x, darkest_y = min_val[2]
    
    return (darkest_x, darkest_y)

def main():
    # Check current animation-3.mov
    input_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-3.mov"
    
    if not input_path.exists():
        print("❌ animation-3.mov not found")
        return
    
    cap = cv2.VideoCapture(str(input_path))
    
    if not cap.isOpened():
        print("❌ Could not open video")
        return
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    # Read first frame
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        print("❌ Could not read frame")
        return
    
    print(f"\n📹 animation-3.mov first frame:")
    print(f"   Size: {width}×{height}")
    
    # Find dot
    dot_x, dot_y = find_dot_center(frame)
    print(f"   Detected dot: ({dot_x}, {dot_y})")
    print(f"   Frame center: ({width//2}, {height//2})")
    print(f"   Offset: ({dot_x - width//2}, {dot_y - height//2})")
    
    # Create visualization
    vis = visualize_frame(frame, (dot_x, dot_y))
    
    # Save
    output_path = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations" / "animation-3-debug.jpg"
    cv2.imwrite(str(output_path), vis)
    
    print(f"\n💾 Debug image saved: animation-3-debug.jpg")
    print(f"   Green crosshair = frame center")
    print(f"   Red circle = detected dot")
    print(f"   Blue circle = 25% detection zone")
    print(f"   Magenta line = offset from center")

if __name__ == "__main__":
    main()

