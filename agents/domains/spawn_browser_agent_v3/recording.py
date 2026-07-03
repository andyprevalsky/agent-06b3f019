"""Dev-only browser-agent replay recording.

Records viewport frames from an existing Playwright page and emits a small
HTML player. This is intentionally local/dev-only; production should rely on
normal browser logs and Steel viewer URLs.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
import structlog

logger = structlog.get_logger()


FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}


def browser_recordings_enabled() -> bool:
    value = os.getenv("BROWSER_AGENT_RECORDINGS", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False

    if os.getenv("ENVIRONMENT") != "production":
        return True
    if os.getenv("CONDUCTOR_WORKSPACE_NAME"):
        return True

    api_url = os.getenv("BACKEND_API_URL", "")
    return "localhost" in api_url or "127.0.0.1" in api_url


def _recording_root() -> Path:
    override = os.getenv("BROWSER_AGENT_RECORDINGS_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / ".context" / "browser-agent-recordings"


def _safe_task_id(task_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in task_id)[:80]


def browser_recording_output_dir(agent_id: str, task_id: str) -> Path:
    return _recording_root() / agent_id / _safe_task_id(task_id)


def _media_extension(url: str, default: str) -> str:
    suffix = Path(urlparse(url).path).suffix
    if suffix and len(suffix) <= 8:
        return suffix
    return default


async def _download_media_file(client: httpx.AsyncClient, url: str, path: Path) -> None:
    response = await client.get(url)
    response.raise_for_status()
    path.write_bytes(response.content)


async def _mux_hls_to_mp4(playlist_path: Path, output_path: Path) -> bool:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        return False
    process = await asyncio.create_subprocess_exec(
        ffmpeg_path,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-allowed_extensions",
        "ALL",
        "-i",
        str(playlist_path),
        "-c",
        "copy",
        str(output_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await process.communicate()
    if process.returncode != 0:
        logger.debug("Steel HLS mux to MP4 failed", error=stderr.decode("utf-8", errors="replace")[:500])
        return False
    return output_path.exists() and output_path.stat().st_size > 0


def _cursor_svg_for_html() -> str:
    svg = """<svg width="28" height="28" viewBox="0 0 427 427" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(427, 0) scale(-1, 1)">
    <g transform="translate(-43, 470) scale(0.1, -0.1)">
      <path d="M669 4687 c-149 -42 -244 -165 -242 -312 1 -77 1202 -3705 1257 -3800 116 -198 438 -191 548 11 15 27 128 389 253 804 322 1072 177 927 1255 1250 830 249 777 231 840 281 165 131 146 408 -36 515 -59 35 -3711 1251 -3777 1258 -29 3 -72 0 -98 -7z"
            fill="#1a1a1a" stroke="#ffffff" stroke-width="40" stroke-linejoin="round"/>
    </g>
  </g>
</svg>"""
    return svg.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


class BrowserAgentRecorder:
    def __init__(
        self,
        *,
        page: Any,
        agent_id: str,
        task_id: str,
        session_id: str,
        browser_url: str,
        session_metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.page = page
        self.agent_id = agent_id
        self.task_id = task_id
        self.session_id = session_id
        self.browser_url = browser_url
        self.session_metadata = session_metadata or {}
        self.output_dir = browser_recording_output_dir(agent_id, task_id)
        self.frames_dir = self.output_dir / "frames"
        self.media_dir = self.output_dir / "media"
        self.frames: List[Dict[str, Any]] = []
        self.cursor_events: List[Dict[str, int]] = []
        self._started_at = time.monotonic()
        self._frame_index = 0
        self._closed = False
        self._consecutive_failures = 0
        self._capture_lock = asyncio.Lock()
        self._loop_task: Optional[asyncio.Task] = None
        self._cursor: Optional[Dict[str, int]] = None
        self._last_label = "idle"
        self._last_metadata: Dict[str, Any] = {}
        self.interval_seconds = max(1 / 30, float(os.getenv("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS", "2")))
        self.render_fps = max(1, int(os.getenv("BROWSER_AGENT_RECORDING_RENDER_FPS", "30")))
        self.max_frames = max(1, int(os.getenv("BROWSER_AGENT_RECORDING_MAX_FRAMES", "900")))

    def set_cursor(self, x: int, y: int) -> None:
        """Update replay cursor position without forcing a screenshot capture."""
        cursor = {"x": int(x), "y": int(y)}
        self._cursor = cursor
        self.cursor_events.append(
            {
                "ts_ms": int((time.monotonic() - self._started_at) * 1000),
                "x": cursor["x"],
                "y": cursor["y"],
            }
        )

    @classmethod
    async def create(
        cls,
        *,
        page: Any,
        agent_id: str,
        task_id: Optional[str],
        session_id: Optional[str],
        browser_url: Optional[str],
        session_metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional["BrowserAgentRecorder"]:
        if not browser_recordings_enabled() or not task_id or not session_id:
            return None
        if not hasattr(page, "screenshot"):
            return None
        recorder = cls(
            page=page,
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            browser_url=browser_url or "",
            session_metadata=session_metadata,
        )
        await recorder.start()
        return recorder

    async def start(self) -> None:
        self.frames_dir.mkdir(parents=True, exist_ok=True)
        await self.capture("recording started", action="start", force=True)
        self._loop_task = asyncio.create_task(self._capture_loop())
        logger.info(
            "Browser agent recording started",
            agent_id=self.agent_id,
            task_id=self.task_id,
            output_dir=str(self.output_dir),
        )

    async def _capture_loop(self) -> None:
        while not self._closed:
            # Back off when the renderer is frozen by a bot-challenge: each failed
            # screenshot already blocks ~5s (Playwright timeout), so hammering every
            # interval just spams failures and contends on the frozen CDP channel.
            # Grow the gap exponentially while failing (cap ~16x), snap back on success.
            backoff = min(2 ** self._consecutive_failures, 16)
            await asyncio.sleep(self.interval_seconds * backoff)
            await self.capture(self._last_label, action="idle")

    async def mark(
        self,
        label: str,
        *,
        action: str = "action",
        cursor: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        force: bool = True,
    ) -> None:
        if cursor and cursor.get("x") is not None and cursor.get("y") is not None:
            self.set_cursor(int(cursor["x"]), int(cursor["y"]))
        self._last_label = label
        next_metadata = dict(metadata or {})
        if self._cursor and "cursor" not in next_metadata:
            next_metadata["cursor"] = dict(self._cursor)
        self._last_metadata = next_metadata
        await self.capture(label, action=action, metadata=next_metadata, force=force)

    async def _screenshot_bytes(self, *, allow_slow_fallback: bool) -> bytes:
        # Forced (action) frames get the full budget; best-effort idle frames use
        # a short timeout so a slow page.screenshot (fonts/stability wait) can't
        # stall the capture loop and block a later forced frame behind the lock.
        timeout_ms = 2500 if allow_slow_fallback else 1200
        return await self.page.screenshot(type="jpeg", quality=55, full_page=False, timeout=timeout_ms)

    async def capture(
        self,
        label: str,
        *,
        action: str,
        metadata: Optional[Dict[str, Any]] = None,
        force: bool = False,
    ) -> None:
        if self._closed or len(self.frames) >= self.max_frames:
            return
        async with self._capture_lock:
            if self._closed or len(self.frames) >= self.max_frames:
                return
            try:
                image_bytes = await self._screenshot_bytes(allow_slow_fallback=force)
                self._consecutive_failures = 0
            except Exception as exc:
                self._consecutive_failures += 1
                if force:
                    logger.warning(
                        "Browser agent recording frame capture failed",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        error=str(exc),
                    )
                return

            self._frame_index += 1
            filename = f"frame_{self._frame_index:05d}.jpg"
            frame_path = self.frames_dir / filename
            frame_path.write_bytes(image_bytes)
            self.frames.append(
                {
                    "src": f"frames/{filename}",
                    "ts_ms": int((time.monotonic() - self._started_at) * 1000),
                    "label": label,
                    "action": action,
                    "cursor": self._cursor,
                    "metadata": dict(metadata if metadata is not None else self._last_metadata),
                    "size": len(image_bytes),
                }
            )

    async def close(self) -> Optional[Path]:
        if self._closed:
            existing_path = self.output_dir / "index.html"
            return existing_path if existing_path.exists() else None
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        await self.capture("recording stopped", action="stop", force=True)
        self._closed = True
        steel_media = await self._download_steel_hls_recording()
        if not self.frames and not steel_media:
            return None
        source_frame_count = len(self.frames)
        playback_frames = self._build_playback_frames() if self.frames else []
        manifest_path = self.output_dir / "manifest.json"
        html_path = self.output_dir / "index.html"
        recording_source = "steel_hls" if steel_media else "screenshot_replay"
        manifest_path.write_text(
            json.dumps(
                {
                    "agent_id": self.agent_id,
                    "task_id": self.task_id,
                    "session_id": self.session_id,
                    "browser_url": self.browser_url,
                    "browser_session_metadata": self.session_metadata,
                    "recording_source": recording_source,
                    "steel_recording": steel_media,
                    "frame_count": len(playback_frames),
                    "source_frame_count": source_frame_count,
                    "render_fps": self.render_fps,
                    "frames": playback_frames,
                    "cursor_events": self.cursor_events,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        # Use the real captured frames (self.frames) for the screenshot replay —
        # _build_playback_frames currently collapses every entry to frame_00001,
        # which made recordings show only the pre-nav splash. The player plays
        # frames uniformly (skip-idle), so real per-frame timing isn't required.
        html_path.write_text(
            self._build_steel_video_html(steel_media) if steel_media else self._build_html(self.frames),
            encoding="utf-8",
        )
        logger.info(
            "Browser agent recording saved",
            agent_id=self.agent_id,
            task_id=self.task_id,
            html_path=str(html_path),
            frame_count=len(playback_frames),
            source_frame_count=source_frame_count,
            recording_source=recording_source,
        )
        return html_path

    def export_inline_html_bytes(self) -> Optional[bytes]:
        """Build a SINGLE self-contained replay HTML with every frame inlined as a
        base64 data URI, so it can be uploaded to Supabase Storage and iframed by
        the front-end without any sibling assets. Works for both recording modes
        (we always have screenshot frames). Returns None when there are no frames."""
        if not self.frames:
            return None
        inlined: List[Dict[str, Any]] = []
        for frame in self._build_playback_frames():
            src = frame.get("src", "")
            frame_copy = dict(frame)
            if isinstance(src, str) and src.startswith("frames/"):
                try:
                    raw = (self.output_dir / src).read_bytes()
                    frame_copy["src"] = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
                except Exception:  # noqa: BLE001 — keep relative src if a frame file is missing
                    pass
            inlined.append(frame_copy)
        return self._build_html(inlined).encode("utf-8")

    async def _download_steel_hls_recording(self) -> Optional[Dict[str, Any]]:
        if self.session_metadata.get("provider") != "steel":
            return None
        api_key = os.getenv("STEEL_API_KEY")
        if not api_key or not self.session_id:
            return None

        hls_url = f"https://api.steel.dev/v1/sessions/{self.session_id}/hls"
        self.media_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = self.media_dir / "recording.m3u8"
        mp4_path = self.media_dir / "recording.mp4"
        hls_js_source = Path(__file__).resolve().parents[3] / "node_modules" / "hls.js" / "dist" / "hls.min.js"
        hls_js_path = self.media_dir / "hls.min.js"
        if hls_js_source.exists() and not hls_js_path.exists():
            shutil.copyfile(hls_js_source, hls_js_path)

        max_wait_seconds = max(0.0, float(os.getenv("BROWSER_AGENT_STEEL_HLS_WAIT_SECONDS", "12")))
        deadline = time.monotonic() + max_wait_seconds
        playlist_text: Optional[str] = None
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            while True:
                try:
                    response = await client.get(hls_url, headers={"steel-api-key": api_key})
                    if response.status_code == 200 and "#EXTM3U" in response.text:
                        playlist_text = response.text
                        break
                    logger.debug(
                        "Steel HLS recording not ready",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        session_id=self.session_id,
                        status=response.status_code,
                        body=response.text[:160],
                    )
                except Exception as exc:
                    logger.debug(
                        "Steel HLS recording fetch failed",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        session_id=self.session_id,
                        error=str(exc),
                    )
                if time.monotonic() >= deadline:
                    return None
                await asyncio.sleep(1)

            assert playlist_text is not None
            rewritten_lines: List[str] = []
            download_index = 0
            for line in playlist_text.splitlines():
                stripped = line.strip()
                if not stripped:
                    rewritten_lines.append(line)
                    continue
                map_match = re.search(r'URI="([^"]+)"', line)
                if map_match:
                    map_url = urljoin(hls_url, map_match.group(1))
                    local_name = f"part_{download_index:05d}{_media_extension(map_url, '.mp4')}"
                    download_index += 1
                    await _download_media_file(client, map_url, self.media_dir / local_name)
                    rewritten_lines.append(line.replace(map_match.group(1), local_name))
                    continue
                if stripped.startswith("#"):
                    rewritten_lines.append(line)
                    continue
                media_url = urljoin(hls_url, stripped)
                local_name = f"part_{download_index:05d}{_media_extension(media_url, '.m4s')}"
                download_index += 1
                await _download_media_file(client, media_url, self.media_dir / local_name)
                rewritten_lines.append(local_name)

        playlist_path.write_text("\n".join(rewritten_lines) + "\n", encoding="utf-8")
        mp4_created = await _mux_hls_to_mp4(playlist_path, mp4_path)
        return {
            "kind": "steel_hls",
            "hls_path": str(playlist_path),
            "hls_src": f"media/{playlist_path.name}",
            "mp4_path": str(mp4_path) if mp4_created else None,
            "mp4_src": f"media/{mp4_path.name}" if mp4_created else None,
            "hls_js_src": f"media/{hls_js_path.name}" if hls_js_path.exists() else None,
            "segment_count": download_index,
        }

    def _cursor_at_time(self, ts_ms: int) -> Optional[Dict[str, int]]:
        if not self.cursor_events:
            return None
        previous = self.cursor_events[0]
        for event in self.cursor_events[1:]:
            if event["ts_ms"] >= ts_ms:
                span = max(1, event["ts_ms"] - previous["ts_ms"])
                t = max(0.0, min(1.0, (ts_ms - previous["ts_ms"]) / span))
                return {
                    "x": int(round(previous["x"] + (event["x"] - previous["x"]) * t)),
                    "y": int(round(previous["y"] + (event["y"] - previous["y"]) * t)),
                }
            previous = event
        return {"x": int(previous["x"]), "y": int(previous["y"])}

    def _build_playback_frames(self) -> List[Dict[str, Any]]:
        if len(self.frames) < 2:
            return list(self.frames)
        frame_step_ms = max(1, int(round(1000 / self.render_fps)))
        last_ts = max(frame["ts_ms"] for frame in self.frames)
        if last_ts < frame_step_ms:
            return list(self.frames)
        playback_frames: List[Dict[str, Any]] = []
        source_index = 0
        ts_ms = 0
        while ts_ms <= last_ts and len(playback_frames) < self.max_frames:
            while source_index + 1 < len(self.frames) and self.frames[source_index + 1]["ts_ms"] <= ts_ms:
                source_index += 1
            source = self.frames[source_index]
            frame = dict(source)
            frame["ts_ms"] = ts_ms
            frame["source_ts_ms"] = source["ts_ms"]
            frame["source_frame_index"] = source_index
            frame["playback_frame"] = True
            cursor = self._cursor_at_time(ts_ms)
            if cursor:
                frame["cursor"] = cursor
                metadata = dict(frame.get("metadata") or {})
                metadata["cursor"] = cursor
                frame["metadata"] = metadata
            playback_frames.append(frame)
            ts_ms += frame_step_ms
        if playback_frames and playback_frames[-1]["ts_ms"] < last_ts and len(playback_frames) < self.max_frames:
            source = self.frames[-1]
            frame = dict(source)
            frame["source_ts_ms"] = source["ts_ms"]
            frame["source_frame_index"] = len(self.frames) - 1
            frame["playback_frame"] = True
            playback_frames.append(frame)
        return playback_frames or list(self.frames)

    def _build_html(self, frames: Optional[List[Dict[str, Any]]] = None) -> str:
        playback_frames = frames if frames is not None else self._build_playback_frames()
        frames_json = json.dumps(playback_frames)
        cursor_events_json = json.dumps(self.cursor_events)
        title = html.escape(f"Browser recording {self.task_id}")
        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    html, body {{ margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0b0c; color: #e8e8ea; }}
    #app {{ display: flex; flex-direction: column; height: 100vh; }}
    header {{ display: flex; gap: 14px; align-items: center; padding: 10px 14px; background: #161618; border-bottom: 1px solid #232327; }}
    button, select {{ font: inherit; background: #232327; color: #fff; border: 1px solid #34343a; border-radius: 8px; padding: 6px 12px; cursor: pointer; }}
    button:hover, select:hover {{ background: #2c2c31; }}
    label {{ font-size: 13px; color: #b5b5bd; display: flex; align-items: center; gap: 6px; }}
    #play {{ min-width: 76px; font-weight: 600; }}
    #timeline {{ flex: 1; accent-color: #6aa7ff; }}
    #time {{ font-variant-numeric: tabular-nums; font-size: 12px; color: #9a9aa3; min-width: 58px; text-align: right; }}
    #stage {{ flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 4px; background: #050506; }}
    canvas {{ max-width: 100%; max-height: 100%; }}
  </style>
</head>
<body>
  <div id="app">
    <header>
      <button id="play">Play</button>
      <label>Speed <select id="speed"><option>1</option><option>2</option><option selected>4</option><option>8</option></select>x</label>
      <label><input id="skipIdle" type="checkbox" checked> skip idle</label>
      <input id="timeline" type="range" min="0" max="0" value="0">
      <span id="time"></span>
    </header>
    <div id="stage"><canvas id="canvas"></canvas></div>
  </div>
<script>
const frames = {frames_json};
const cursorEvents = {cursor_events_json};
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const playBtn = document.getElementById('play');
const speed = document.getElementById('speed');
const skipIdle = document.getElementById('skipIdle');
const timeline = document.getElementById('timeline');
const time = document.getElementById('time');
// skip-idle: play one frame at a time (uniform), dropping the dead gaps — e.g.
// the ~90s bot-challenge freeze where the renderer holds a single frame. Off =
// real capture timestamps.
const FRAME_MS = 500;
function buildEff(skip) {{ return skip ? frames.map((_, i) => i * FRAME_MS) : frames.map((f) => f.ts_ms || 0); }}
let eff = buildEff(skipIdle.checked);
let totalMs = eff.length ? eff[eff.length - 1] : 0;
timeline.max = totalMs;
timeline.step = 1;
let playheadMs = 0;
let playing = false;
let rafId = null;
let lastRafMs = null;
const images = frames.map(f => {{ const img = new Image(); img.src = f.src; return img; }});
function normalizeCursor(cursor) {{
  if (!cursor || cursor.x == null || cursor.y == null) return null;
  const x = Number(cursor.x), y = Number(cursor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {{ x, y }};
}}
function frameCursor(frame) {{
  return normalizeCursor(frame.cursor)
    || normalizeCursor(frame.metadata && frame.metadata.cursor)
    || normalizeCursor(frame.metadata && frame.metadata.coordinates);
}}
const firstCursor = cursorEvents[0] || frames.map(frameCursor).find(Boolean) || null;
const cursorByFrame = [];
let lastCursor = firstCursor;
frames.forEach(frame => {{
  const nextCursor = frameCursor(frame);
  if (nextCursor) lastCursor = nextCursor;
  cursorByFrame.push(lastCursor);
}});
function cursorAtTime(tsMs) {{
  if (!cursorEvents.length) return null;
  let lo = 0, hi = cursorEvents.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (cursorEvents[mid].ts_ms <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  if (hi < 0) return cursorEvents[0];
  if (hi >= cursorEvents.length - 1) return cursorEvents[cursorEvents.length - 1];
  const a = cursorEvents[hi], b = cursorEvents[hi + 1];
  const span = Math.max(1, b.ts_ms - a.ts_ms);
  const t = Math.max(0, Math.min(1, (tsMs - a.ts_ms) / span));
  return {{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }};
}}
function frameIndexAtTime(tsMs) {{
  if (!eff.length) return 0;
  let lo = 0, hi = eff.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (eff[mid] <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  return Math.max(0, Math.min(frames.length - 1, hi));
}}
function drawCursor(c) {{
  if (!c) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(6, 17); ctx.lineTo(10, 28); ctx.lineTo(15, 26); ctx.lineTo(11, 15); ctx.lineTo(20, 15); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}}
function renderAt(tsMs) {{
  playheadMs = Math.max(0, Math.min(totalMs, tsMs));
  const idx = frameIndexAtTime(playheadMs);
  const img = images[idx], f = frames[idx];
  const paint = () => {{
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 800;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawCursor(cursorByFrame[idx]);
    timeline.value = Math.round(playheadMs);
    time.textContent = `${{(playheadMs / 1000).toFixed(2)}}s`;
  }};
  if (img.complete) paint(); else img.onload = paint;
}}
function tick(nowMs) {{
  if (!playing) return;
  if (lastRafMs == null) lastRafMs = nowMs;
  const deltaMs = Math.max(0, nowMs - lastRafMs) * Number(speed.value || 1);
  lastRafMs = nowMs;
  renderAt(playheadMs + deltaMs);
  if (playheadMs >= totalMs) {{
    playing = false;
    playBtn.textContent = 'Play';
    lastRafMs = null;
    return;
  }}
  rafId = requestAnimationFrame(tick);
}}
playBtn.onclick = () => {{
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
  if (rafId) cancelAnimationFrame(rafId);
  lastRafMs = null;
  if (playing) rafId = requestAnimationFrame(tick);
}};
timeline.oninput = e => {{
  playing = false;
  playBtn.textContent = 'Play';
  if (rafId) cancelAnimationFrame(rafId);
  lastRafMs = null;
  renderAt(Number(e.target.value));
}};
skipIdle.onchange = () => {{
  const cur = frameIndexAtTime(playheadMs);
  eff = buildEff(skipIdle.checked);
  totalMs = eff.length ? eff[eff.length - 1] : 0;
  timeline.max = totalMs;
  renderAt(eff[cur] || 0);
}};
renderAt(0);
</script>
</body>
</html>
"""

    def _build_steel_video_html(self, media: Dict[str, Any]) -> str:
        cursor_events_json = json.dumps(self.cursor_events)
        title = html.escape(f"Browser recording {self.task_id}")
        mp4_src = json.dumps(media.get("mp4_src"))
        hls_src = json.dumps(media.get("hls_src"))
        hls_js_src = json.dumps(media.get("hls_js_src"))
        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111; color: #f5f5f5; }}
    header {{ display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: #1e1e1e; position: sticky; top: 0; z-index: 2; }}
    button, select, label {{ font: inherit; }}
    button, select {{ background: #2b2b2b; color: #fff; border: 1px solid #555; border-radius: 6px; padding: 5px 8px; }}
    #stage {{ position: relative; width: min(100vw, 1288px); margin: 0 auto; background: #050505; }}
    video {{ display: block; width: 100%; height: auto; background: #050505; }}
    #cursor {{ position: absolute; width: 28px; height: 28px; pointer-events: none; z-index: 3; filter: drop-shadow(2px 3px 3px rgba(0,0,0,.5)); transform: translateX(-28px); }}
    #meta {{ max-width: 1288px; margin: 10px auto; color: #bdbdbd; font-size: 12px; }}
  </style>
</head>
<body>
  <header>
    <button id="play">Play</button>
    <label>Speed <select id="speed"><option>1</option><option>2</option><option selected>4</option><option>8</option></select>x</label>
    <span id="time"></span>
  </header>
  <div id="stage">
    <video id="video" controls playsinline preload="metadata"></video>
    <div id="cursor" aria-hidden="true"></div>
  </div>
  <div id="meta">
    <div><strong>{html.escape(self.task_id)}</strong></div>
    <div>Source: Steel MP4/HLS debug recording</div>
    <div>Session: {html.escape(self.session_id)}</div>
  </div>
  <script>
const cursorEvents = {cursor_events_json};
const mp4Src = {mp4_src};
const hlsSrc = {hls_src};
const hlsJsSrc = {hls_js_src};
const video = document.getElementById('video');
const playBtn = document.getElementById('play');
const speed = document.getElementById('speed');
const time = document.getElementById('time');
const cursor = document.getElementById('cursor');
cursor.innerHTML = `{_cursor_svg_for_html()}`;
const BROWSER_WINDOW_WIDTH = 1288;
const BROWSER_WINDOW_HEIGHT = 891;
const CONTENT_OFFSET_X = 4;
const CONTENT_OFFSET_Y = 91;
function cursorAtTime(tsMs) {{
  if (!cursorEvents.length) return null;
  let lo = 0, hi = cursorEvents.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (cursorEvents[mid].ts_ms <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  if (hi < 0) return cursorEvents[0];
  if (hi >= cursorEvents.length - 1) return cursorEvents[cursorEvents.length - 1];
  const a = cursorEvents[hi], b = cursorEvents[hi + 1];
  const span = Math.max(1, b.ts_ms - a.ts_ms);
  const t = Math.max(0, Math.min(1, (tsMs - a.ts_ms) / span));
  return {{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }};
}}
function placeCursor() {{
  const c = cursorAtTime(video.currentTime * 1000);
  if (c) {{
    const scaleX = video.clientWidth / BROWSER_WINDOW_WIDTH;
    const scaleY = video.clientHeight / BROWSER_WINDOW_HEIGHT;
    cursor.style.left = `${{(CONTENT_OFFSET_X + c.x) * scaleX}}px`;
    cursor.style.top = `${{(CONTENT_OFFSET_Y + c.y) * scaleY}}px`;
  }}
  time.textContent = `${{video.currentTime.toFixed(2)}}s`;
  requestAnimationFrame(placeCursor);
}}
function loadVideo() {{
  if (mp4Src) {{
    video.src = mp4Src;
    return;
  }}
  if (video.canPlayType('application/vnd.apple.mpegurl')) {{
    video.src = hlsSrc;
    return;
  }}
  if (hlsJsSrc) {{
    const script = document.createElement('script');
    script.src = hlsJsSrc;
    script.onload = () => {{
      const hls = new Hls();
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
    }};
    document.head.appendChild(script);
  }}
}}
playBtn.onclick = () => {{
  video.playbackRate = Number(speed.value || 1);
  if (video.paused) {{ video.play(); playBtn.textContent = 'Pause'; }}
  else {{ video.pause(); playBtn.textContent = 'Play'; }}
}};
speed.onchange = () => {{ video.playbackRate = Number(speed.value || 1); }};
video.onplay = () => {{ playBtn.textContent = 'Pause'; }};
video.onpause = () => {{ playBtn.textContent = 'Play'; }};
loadVideo();
requestAnimationFrame(placeCursor);
  </script>
</body>
</html>
"""


def browser_network_recording_enabled() -> bool:
    value = os.getenv("BROWSER_AGENT_NETWORK_RECORDING", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return browser_recordings_enabled()


class BrowserNetworkRecorder:
    """Dev-only CDP network recorder for response-body debugging."""

    STATIC_EXTENSIONS = (
        ".css",
        ".js",
        ".mjs",
        ".map",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".woff",
        ".woff2",
        ".ttf",
        ".mp4",
        ".webm",
        ".mp3",
        ".wav",
    )
    CAPTURE_RESOURCE_TYPES = {"XHR", "Fetch", "Document"}

    def __init__(
        self,
        *,
        browser_session: Any,
        agent_id: str,
        task_id: str,
        session_id: str,
        output_dir: Path,
    ) -> None:
        self.browser_session = browser_session
        self.agent_id = agent_id
        self.task_id = task_id
        self.session_id = session_id
        self.output_dir = output_dir
        self.network_dir = self.output_dir / "network"
        self.entries: Dict[str, Dict[str, Any]] = {}
        self._started_at = time.monotonic()
        self._closed = False
        self._tasks: set[asyncio.Task] = set()
        self._cdp_client: Any = None
        self._max_entries = max(1, int(os.getenv("BROWSER_AGENT_NETWORK_MAX_ENTRIES", "300")))
        self._max_body_bytes = max(1024, int(os.getenv("BROWSER_AGENT_NETWORK_MAX_BODY_BYTES", "262144")))
        self._patterns = [
            item.strip().lower()
            for item in os.getenv("BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS", "").split(",")
            if item.strip()
        ]

    @classmethod
    async def create(
        cls,
        *,
        browser_session: Any,
        agent_id: str,
        task_id: Optional[str],
        session_id: Optional[str],
        output_dir: Path,
    ) -> Optional["BrowserNetworkRecorder"]:
        if not browser_network_recording_enabled() or not task_id or not session_id:
            return None
        if not hasattr(browser_session, "get_or_create_cdp_session"):
            logger.warning(
                "Browser network response-body recording unavailable: no CDP session API",
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
            )
            return None
        recorder = cls(
            browser_session=browser_session,
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            output_dir=output_dir,
        )
        try:
            await recorder.start()
        except Exception as exc:
            logger.warning(
                "Browser network response-body recording failed to start",
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                error=str(exc),
            )
            return None
        return recorder

    async def start(self) -> None:
        self.network_dir.mkdir(parents=True, exist_ok=True)
        cdp_session = await self.browser_session.get_or_create_cdp_session()
        cdp_client = getattr(self.browser_session, "cdp_client", None) or cdp_session.cdp_client
        self._cdp_client = cdp_client
        cdp = cdp_client.register
        cdp.Network.requestWillBeSent(self._on_request_will_be_sent)
        cdp.Network.responseReceived(self._on_response_received)
        cdp.Network.loadingFinished(self._on_loading_finished)
        cdp.Network.loadingFailed(self._on_loading_failed)

        await cdp_client.send.Network.enable(session_id=cdp_session.session_id)
        logger.info(
            "Browser network response-body recording started",
            agent_id=self.agent_id,
            task_id=self.task_id,
            session_id=self.session_id,
            output_dir=str(self.network_dir),
        )

    def _should_capture(self, url: str, resource_type: str, mime_type: str = "") -> bool:
        if not url.startswith(("http://", "https://")):
            return False
        lower_url = url.lower()
        if any(lower_url.split("?", 1)[0].endswith(ext) for ext in self.STATIC_EXTENSIONS):
            return False
        if self._patterns:
            return any(pattern in lower_url for pattern in self._patterns)
        if resource_type not in self.CAPTURE_RESOURCE_TYPES:
            return False
        lower_mime = (mime_type or "").lower()
        return not lower_mime or any(
            marker in lower_mime
            for marker in ("json", "text/", "html", "xml", "x-www-form-urlencoded", "javascript")
        )

    def _on_request_will_be_sent(self, event: Dict[str, Any], session_id: str | None) -> None:
        try:
            request_id = event.get("requestId")
            request = event.get("request") or {}
            url = request.get("url") or ""
            resource_type = event.get("type") or ""
            if not request_id or len(self.entries) >= self._max_entries:
                return
            if not self._should_capture(url, resource_type):
                return
            self.entries[request_id] = {
                "request_id": request_id,
                "session_id": session_id,
                "method": request.get("method"),
                "url": url,
                "resource_type": resource_type,
                "request_ts_ms": int((time.monotonic() - self._started_at) * 1000),
            }
        except Exception as exc:
            logger.warning("Browser network request capture failed", error=str(exc))

    def _on_response_received(self, event: Dict[str, Any], session_id: str | None) -> None:
        try:
            request_id = event.get("requestId")
            response = event.get("response") or {}
            url = response.get("url") or ""
            resource_type = event.get("type") or ""
            mime_type = response.get("mimeType") or ""
            if not request_id or len(self.entries) >= self._max_entries:
                return
            if not self._should_capture(url, resource_type, mime_type):
                return
            entry = self.entries.setdefault(
                request_id,
                {
                    "request_id": request_id,
                    "session_id": session_id,
                    "url": url,
                    "resource_type": resource_type,
                },
            )
            entry.update(
                {
                    "session_id": session_id,
                    "url": url,
                    "resource_type": resource_type,
                    "status": response.get("status"),
                    "mime_type": mime_type,
                    "response_ts_ms": int((time.monotonic() - self._started_at) * 1000),
                }
            )
        except Exception as exc:
            logger.warning("Browser network response capture failed", error=str(exc))

    def _on_loading_finished(self, event: Dict[str, Any], session_id: str | None) -> None:
        request_id = event.get("requestId")
        if not request_id or request_id not in self.entries:
            return
        self.entries[request_id]["encoded_data_length"] = event.get("encodedDataLength")
        task = asyncio.create_task(self._fetch_response_body(request_id, session_id))
        self._tasks.add(task)
        task.add_done_callback(lambda done: self._tasks.discard(done))

    def _on_loading_failed(self, event: Dict[str, Any], session_id: str | None) -> None:
        request_id = event.get("requestId")
        if request_id and request_id in self.entries:
            self.entries[request_id]["failed"] = True
            self.entries[request_id]["failure"] = event.get("errorText")

    async def _fetch_response_body(self, request_id: str, session_id: str | None) -> None:
        entry = self.entries.get(request_id)
        if not entry or self._closed:
            return
        try:
            response = await self._cdp_client.send.Network.getResponseBody(
                params={"requestId": request_id},
                session_id=session_id,
            )
            body = response.get("body", "")
            if response.get("base64Encoded"):
                body_bytes = base64.b64decode(body)
            else:
                body_bytes = body.encode("utf-8", errors="replace") if isinstance(body, str) else bytes(body or b"")
            original_size = len(body_bytes)
            truncated = original_size > self._max_body_bytes
            if truncated:
                body_bytes = body_bytes[: self._max_body_bytes]

            index = len([item for item in self.entries.values() if item.get("body_file")]) + 1
            extension = ".json" if "json" in str(entry.get("mime_type", "")).lower() else ".txt"
            body_path = self.network_dir / f"{index:04d}_{request_id.replace('.', '_')}{extension}"
            body_path.write_bytes(body_bytes)
            entry.update(
                {
                    "body_file": body_path.name,
                    "body_size": original_size,
                    "body_truncated": truncated,
                    "body_base64_encoded": bool(response.get("base64Encoded")),
                    "body_captured_at_ms": int((time.monotonic() - self._started_at) * 1000),
                }
            )
            logger.info(
                "Browser network response body captured",
                agent_id=self.agent_id,
                task_id=self.task_id,
                status=entry.get("status"),
                url=entry.get("url"),
                body_file=str(body_path),
                body_size=original_size,
                body_truncated=truncated,
            )
        except Exception as exc:
            entry["body_error"] = str(exc)
            logger.warning(
                "Browser network response body capture failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                request_id=request_id,
                url=entry.get("url"),
                error=str(exc),
            )

    async def close(self) -> Optional[Path]:
        if self._closed:
            return self.network_dir / "index.json" if self.entries else None
        if self._tasks:
            done, pending = await asyncio.wait(self._tasks, timeout=3)
            for task in pending:
                task.cancel()
            if pending:
                logger.warning(
                    "Browser network response body recorder closed with pending captures",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    pending=len(pending),
                    completed=len(done),
                )
        self._closed = True
        if not self.entries:
            return None
        index_path = self.network_dir / "index.json"
        index_path.write_text(
            json.dumps(
                {
                    "agent_id": self.agent_id,
                    "task_id": self.task_id,
                    "session_id": self.session_id,
                    "entry_count": len(self.entries),
                    "entries": list(self.entries.values()),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        logger.info(
            "Browser network response-body recording saved",
            agent_id=self.agent_id,
            task_id=self.task_id,
            index_path=str(index_path),
            entry_count=len(self.entries),
        )
        return index_path
