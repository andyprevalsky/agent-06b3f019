#!/usr/bin/env bash
# Regenerate this example's media with ffmpeg (no source assets needed).
# Output: orb.mp4 (H.264 loop, ~20 KB), orb.avif + orb.webp stills (posters).
# The same 128x128 animation as a GIF would be several hundred KB.
set -euo pipefail
cd "$(dirname "$0")"
SRC="gradients=s=128x128:c0=0x7c3aed:c1=0xf43f5e:c2=0x06b6d4:c3=0x0e0d16:n=4:speed=0.03:d=2:r=30:seed=7"
# 2 s forward + 2 s reversed = a seamless 4 s ping-pong loop.
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "$SRC" \
  -filter_complex "[0]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1,format=yuv420p" \
  -c:v libx264 -preset veryslow -crf 30 -movflags +faststart -an orb.mp4
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "$SRC" -frames:v 1 -c:v libaom-av1 -still-picture 1 -crf 40 orb.avif
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "$SRC" -frames:v 1 -c:v libwebp -quality 70 orb.webp
ls -l orb.mp4 orb.avif orb.webp
