# Video to ASCII Converter

This script converts the Navi hero animation video into ASCII art frames based on luminescence values, similar to early Midjourney's ASCII loading animations.

## Installation

```bash
pip3 install -r requirements.txt
```

## Usage

To regenerate the ASCII frames from the hero animation video:

```bash
python3 video-to-ascii.py
```

This will:
1. Extract frames from `/public/navi-hero-animation.webm`
2. Convert each frame to grayscale
3. Map pixel luminescence values to ASCII characters
4. Save the frames as JSON to `/src/components/terminal/ascii-frames.json`

## Configuration

You can adjust these parameters in `video-to-ascii.py`:

- `num_frames`: Number of frames to extract (default: `None` to use ALL frames from the video for perfect loop)
- `width`: Width of ASCII art in characters (default: 50)
- `ASCII_CHARS`: Character set ordered by luminance (default: more whitespace for stable animation)

## How It Works

1. **Frame Extraction**: Samples frames evenly throughout the video
2. **Preprocessing**: 
   - Converts to grayscale
   - Applies Gaussian blur to reduce noise
   - Enhances contrast using histogram equalization
3. **ASCII Mapping**: Maps each pixel's brightness (0-255) to an ASCII character based on luminance
4. **Export**: Saves all frames as a JSON array for use in React components

## Output

The script generates `ascii-frames.json` which is imported by the `AsciiLoader` component to display an animated ASCII art loader when an agent is starting up.

