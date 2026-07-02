"""One-off: retroactively upload an agent's already-saved browser recordings to
Supabase Storage and print the FilePointer per task_id, so the recording_file_pointer
can be stamped onto the existing recording messages (enables the FE chip's Recording tab).

Usage: cd agents && source .env && venv/bin/python scripts/backfill_browser_recordings.py <agent_id> <user_id>
"""
import asyncio
import base64
import json
import sys

from domains.spawn_browser_agent_v3.recording import (
    BrowserAgentRecorder,
    browser_recording_output_dir,
)
from helpers.attachments import upload_to_storage


def build_inline_html(agent_id: str, task_id: str) -> bytes | None:
    out_dir = browser_recording_output_dir(agent_id, task_id)
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return None
    manifest = json.loads(manifest_path.read_text())
    # The manifest's interpolated playback frames are broken (every entry points
    # at frame_00001), so read the real captured frame files directly and play
    # them uniformly (skip-idle). Each on-disk frame is a distinct capture.
    frame_files = sorted((out_dir / "frames").glob("frame_*.jpg"))
    if not frame_files:
        return None
    rec = BrowserAgentRecorder(
        page=None,
        agent_id=agent_id,
        task_id=task_id,
        session_id=manifest.get("session_id") or "",
        browser_url=manifest.get("browser_url") or "",
        session_metadata=manifest.get("browser_session_metadata") or {},
    )
    rec.cursor_events = []
    inlined = []
    for i, fp in enumerate(frame_files):
        try:
            raw = fp.read_bytes()
        except Exception:
            continue
        inlined.append(
            {
                "src": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
                "ts_ms": i * 500,
                "action": "",
                "label": "",
            }
        )
    if not inlined:
        return None
    return rec._build_html(inlined).encode("utf-8")


async def main() -> int:
    agent_id, user_id = sys.argv[1], sys.argv[2]
    base = browser_recording_output_dir(agent_id, "x").parent
    task_ids = sorted(p.name for p in base.iterdir() if p.is_dir())
    results = {}
    for task_id in task_ids:
        html = build_inline_html(agent_id, task_id)
        if not html:
            print(f"SKIP {task_id}: no frames", file=sys.stderr)
            continue
        fp = await upload_to_storage(
            user_id=user_id,
            file_content=html,
            filename=f"browser-recording-{task_id}.html",
            mime_type="text/html",
        )
        results[task_id] = fp
        print(f"UPLOADED {task_id}: {len(html)} bytes -> {fp.get('storage_path')}", file=sys.stderr)
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
