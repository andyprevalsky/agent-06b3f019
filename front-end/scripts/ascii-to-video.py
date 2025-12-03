#!/usr/bin/env python3
"""
Render ASCII frames to video for social sharing.
Midjourney style: ROSE LABS text on dark bg box, ASCII animation in margins around it.
"""

import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import subprocess
import tempfile
import os
import pyfiglet

# Video settings
WIDTH = 1200
HEIGHT = 630
FPS = 25
BG_COLOR = (238, 239, 242)  # Off-white #EEEFF2 (matches terminal)
GRID_COLOR = (229, 231, 235)  # Tile grid lines #E5E7EB
GRID_SIZE = 143  # Tile size from terminal

# Gradient colors for ASCII animation (dark on white bg)
GRADIENT_COLORS = [
    (60, 60, 58),
    (80, 80, 78),
    (100, 100, 98),
    (120, 120, 118),
    (140, 140, 138),
]

# Generate ASCII art text using pyfiglet (Midjourney style)
# Strip empty lines from top and bottom for accurate bounds
_raw_ascii = pyfiglet.figlet_format('ROSE LABS', font='small')
ROSE_LABS_ASCII = '\n'.join(line for line in _raw_ascii.split('\n') if line.strip())

def get_gradient_color(y, total_height):
    """Get interpolated gradient color for a given y position."""
    position = y / total_height
    segment = position * (len(GRADIENT_COLORS) - 1)
    idx = int(segment)
    if idx >= len(GRADIENT_COLORS) - 1:
        return GRADIENT_COLORS[-1]
    
    t = segment - idx
    c1, c2 = GRADIENT_COLORS[idx], GRADIENT_COLORS[idx + 1]
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

def render_frame(ascii_text, font, overlay_font, frame_num, temp_dir, text_box_rect, anim_bounds):
    """Render a single ASCII frame with text on white box, animation in margins."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    
    # Draw tile grid pattern (matching terminal exactly)
    # Grid color: rgb(229, 231, 235) - same as terminal
    grid_stroke = (229, 231, 235)
    
    # Draw vertical lines
    for x in range(0, WIDTH + GRID_SIZE, GRID_SIZE):
        draw.line([(x, 0), (x, HEIGHT)], fill=grid_stroke, width=1)
    # Draw horizontal lines
    for y in range(0, HEIGHT + GRID_SIZE, GRID_SIZE):
        draw.line([(0, y), (WIDTH, y)], fill=grid_stroke, width=1)
    
    # Draw corner diamonds at each intersection (concave diamond shape)
    diamond_size = 11
    for gx in range(0, WIDTH + GRID_SIZE, GRID_SIZE):
        for gy in range(0, HEIGHT + GRID_SIZE, GRID_SIZE):
            # Draw a small filled diamond at each grid intersection
            diamond = [
                (gx, gy - diamond_size),  # top
                (gx + diamond_size, gy),  # right
                (gx, gy + diamond_size),  # bottom
                (gx - diamond_size, gy),  # left
            ]
            draw.polygon(diamond, fill=grid_stroke)
    
    lines = ascii_text.split('\n')
    
    # Calculate text dimensions for background ASCII
    bbox = font.getbbox('M')
    char_width = bbox[2] - bbox[0]
    char_height = bbox[3] - bbox[1]
    line_height = char_height + 1
    
    # Animation should be centered
    anim_center_x, _ = anim_bounds
    
    # Calculate natural size
    natural_width = max(len(line) for line in lines) * char_width
    natural_height = len(lines) * line_height
    
    # Center animation horizontally
    start_x = anim_center_x - (natural_width // 2)
    start_y = (HEIGHT - natural_height) // 2
    
    # Draw ASCII animation in the background (will be partially covered by white box)
    for i, line in enumerate(lines):
        y = start_y + i * line_height
        color = get_gradient_color(i, len(lines))
        draw.text((start_x, y), line, font=font, fill=color)
    
    # Draw white rectangle where text will go (2px visual margin top and bottom)
    box_x, box_y, box_w, box_h = text_box_rect
    box_y_shifted = box_y + 15  # Shift down 15px
    padding_x = 6  # Small horizontal padding
    margin = 2  # 2px visual margin on top and bottom
    draw.rectangle(
        [box_x - padding_x, box_y_shifted - margin, box_x + box_w + padding_x, box_y_shifted + box_h + margin],
        fill=BG_COLOR
    )
    
    # Draw ROSE LABS text on the white box
    overlay_lines = ROSE_LABS_ASCII.split('\n')
    overlay_bbox = overlay_font.getbbox('M')
    overlay_char_width = overlay_bbox[2] - overlay_bbox[0]
    overlay_char_height = overlay_bbox[3] - overlay_bbox[1]
    overlay_line_height = overlay_char_height + 1
    
    for i, line in enumerate(overlay_lines):
        y = box_y_shifted + i * overlay_line_height - 15  # Text relative to shifted box, still 15px up within box
        # Dark text on white background
        darkness = 0.1 + 0.1 * (i / max(len(overlay_lines), 1))
        color = (int(255 * darkness), int(255 * darkness), int(250 * darkness))
        draw.text((box_x, y), line, font=overlay_font, fill=color)
    
    # Save frame
    frame_path = os.path.join(temp_dir, f'frame_{frame_num:04d}.png')
    img.save(frame_path)
    return frame_path

def main():
    base_dir = Path(__file__).parent.parent
    
    # Load ASCII frames
    frames_path = base_dir / "src" / "components" / "terminal" / "ascii-frames-engine.json"
    if not frames_path.exists():
        frames_path = base_dir / "src" / "components" / "terminal" / "ascii-frames.json"
    
    with open(frames_path) as f:
        frames = json.load(f)
    
    print(f"Loaded {len(frames)} ASCII frames from {frames_path.name}")
    print(f"\nROSE LABS ASCII art:\n{ROSE_LABS_ASCII}\n")
    
    # Load monospace fonts
    font_paths = [
        "/System/Library/Fonts/Monaco.dfont",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    
    font = None
    for fp in font_paths:
        try:
            font = ImageFont.truetype(fp, 31)  # Large for background animation (+10%)
            overlay_font = ImageFont.truetype(fp, 22)  # Text overlay
            print(f"Using font: {fp}")
            break
        except:
            continue
    
    if font is None:
        print("Warning: Using default font")
        font = ImageFont.load_default()
        overlay_font = font
    
    # Calculate ROSE LABS text box dimensions
    overlay_lines = ROSE_LABS_ASCII.split('\n')
    overlay_bbox = overlay_font.getbbox('M')
    overlay_char_width = overlay_bbox[2] - overlay_bbox[0]
    overlay_char_height = overlay_bbox[3] - overlay_bbox[1]
    overlay_line_height = overlay_char_height + 1
    
    text_box_h = len(overlay_lines) * overlay_line_height
    text_box_w = max(len(line) for line in overlay_lines) * overlay_char_width
    text_box_x = (WIDTH - text_box_w) // 2
    text_box_y = (HEIGHT - text_box_h) // 2
    
    text_box_rect = (text_box_x, text_box_y, text_box_w, text_box_h)
    
    # Animation centered
    anim_center_x = WIDTH // 2
    anim_bounds = (anim_center_x, text_box_w)
    
    print(f"Text box: {text_box_w}x{text_box_h} at ({text_box_x}, {text_box_y})")
    
    # Ensure output directory exists
    output_dir = base_dir / "public" / "social"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Render frames to temp directory
    with tempfile.TemporaryDirectory() as temp_dir:
        print("Rendering frames...")
        for i, frame in enumerate(frames):
            render_frame(frame, font, overlay_font, i, temp_dir, text_box_rect, anim_bounds)
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(frames)}")
        
        print(f"  {len(frames)}/{len(frames)} ✓")
        
        # Combine into video with ffmpeg
        video_path = output_dir / "rose-preview.mp4"
        
        print("Encoding video...")
        result = subprocess.run([
            'ffmpeg', '-y',
            '-framerate', str(FPS),
            '-i', os.path.join(temp_dir, 'frame_%04d.png'),
            '-c:v', 'libx264',
            '-crf', '18',
            '-preset', 'medium',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            str(video_path)
        ], capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"FFmpeg error: {result.stderr}")
            return
        
        print(f"✅ Saved video: {video_path}")
        
        # Print file size
        video_size = video_path.stat().st_size / 1024
        print(f"\nFile size: {video_size:.1f} KB")

if __name__ == "__main__":
    main()
