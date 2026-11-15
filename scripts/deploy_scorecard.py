#!/usr/bin/env python3
"""Render the deploy-summary-v2 scorecard (`scripts/deploy scorecard`).

Fills `.claude/shared/deploy-scorecard-template.html` from a JSON spec of recorded facts,
so the card is never hand-edited HTML. The spec carries plain text (escaped here, with only
`inline code` and [label](https://...) links rendered) and timestamped intervals. Bars, the
shared elapsed-time axis and the work/automation/wait totals are computed from those
instants on the deploy's original clock; overlapping intervals are unioned, never double
counted. Invalid specs are refused, never patched.

    spec = {"title", "shipped", "start", "end", "deployed": [text], "note"?,
            "delegated": [{"text", "url"}], "providers": [text], "followups": [text],
            "segments": [{"row", "kind": work|automation|wait|unrecorded,
                          "start", "end", "label", "reason"?}]}

    scripts/deploy scorecard --spec card.json --output card.html
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / '.claude/shared/deploy-scorecard-template.html'
PACIFIC = ZoneInfo('America/Los_Angeles')
KINDS = {'work': '#2f5fc4', 'automation': '#4b74d6', 'wait': '#d39b3a', 'unrecorded': ''}
REQUIRED = ('title', 'shipped', 'start', 'end', 'deployed', 'delegated', 'providers', 'followups', 'segments')


def need(value, message: str) -> None:
    if not value:
        raise ValueError('scorecard spec: ' + message)


def instant(value) -> dt.datetime:
    need(isinstance(value, str), f'timestamp must be an ISO string: {value!r}')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError(f'scorecard spec: invalid timestamp {value!r}') from None
    need(parsed.tzinfo is not None, f'timestamp needs a zone: {value!r}')
    return parsed.astimezone(dt.timezone.utc)


def duration(seconds: float) -> str:
    seconds = int(round(seconds))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    return (f'{days}d' if days else '') + (f'{hours}h' if hours or days else '') + f'{minutes}m'


def pacific(moment: dt.datetime, fmt: str = '%b %-d, %-I:%M %p %Z') -> str:
    return moment.astimezone(PACIFIC).strftime(fmt)


def inline(text) -> str:
    """Escape text; render only `code` and [label](https://...) links."""
    need(isinstance(text, str), 'text entries must be strings')
    escaped = html.escape(text, quote=True)
    escaped = re.sub(r'`([^`]+)`', r'<code>\1</code>', escaped)
    return re.sub(r'\[([^\]]+)\]\((https://[^\s)"<>]+)\)', r'<a href="\2">\1</a>', escaped)


def union(intervals: list[tuple[dt.datetime, dt.datetime]]) -> float:
    total, current = 0.0, None
    for start, end in sorted(intervals):
        if current and start <= current[1]:
            current = (current[0], max(current[1], end))
            continue
        if current:
            total += (current[1] - current[0]).total_seconds()
        current = (start, end)
    if current:
        total += (current[1] - current[0]).total_seconds()
    return total


def render(spec: dict) -> str:
    need(isinstance(spec, dict) and all(key in spec for key in REQUIRED), 'missing required fields ' + ', '.join(REQUIRED))
    start, end = instant(spec['start']), instant(spec['end'])
    need(end > start, 'end must be after start')
    need(isinstance(spec['deployed'], list) and spec['deployed'], 'deployed needs at least one paragraph')
    span = (end - start).total_seconds()
    rows: dict[str, list[tuple[str, dt.datetime, dt.datetime, str]]] = {}
    by_kind: dict[str, list[tuple[dt.datetime, dt.datetime]]] = {kind: [] for kind in KINDS}
    reasons: dict[str, list[tuple[dt.datetime, dt.datetime]]] = {}
    for segment in spec['segments']:
        need(isinstance(segment, dict) and {'row', 'kind', 'start', 'end', 'label'} <= set(segment), 'segment fields')
        need(segment['kind'] in KINDS, f"unknown segment kind {segment['kind']!r}")
        seg_start, seg_end = instant(segment['start']), instant(segment['end'])
        need(seg_end > seg_start, f"segment {segment['label']!r} ends before it starts")
        clamped = (max(seg_start, start), min(seg_end, end))
        if clamped[1] <= clamped[0]:
            continue
        rows.setdefault(str(segment['row']), []).append((segment['kind'], *clamped, str(segment['label'])))
        by_kind[segment['kind']].append(clamped)
        if segment['kind'] == 'wait':
            reasons.setdefault(str(segment.get('reason') or segment['label']), []).append(clamped)

    def position(moment: dt.datetime) -> float:
        return (moment - start).total_seconds() / span * 100

    tick_fmt = '%b %-d' if span > 36 * 3600 else '%-I:%M %p'
    ticks = ''.join(f'<span style="left:{min(88.0, 100 * i / 4):.2f}%">{html.escape(pacific(start + dt.timedelta(seconds=span * i / 4), tick_fmt))}</span>'
                    for i in (1, 2, 3))
    lines = [f'<div class="stage axis-row"><span></span><span class="axis">{ticks}</span><span></span></div>']
    for row, segments in rows.items():
        fills = ''
        for kind, seg_start, seg_end, label in segments:
            width = max(position(seg_end) - position(seg_start), 0.25)
            style = f'left:{position(seg_start):.2f}%;width:{width:.2f}%;' + (f'background:{KINDS[kind]};' if KINDS[kind] else '')
            css = 'fill unrecorded' if kind == 'unrecorded' else 'fill'
            fills += f'<span class="{css}" title="{html.escape(label, quote=True)}" style="{style}"></span>'
        total = union([(a, b) for _, a, b, _ in segments])
        lines.append(f'<div class="stage"><span class="stage-label">{html.escape(row)}</span>'
                     f'<span class="track">{fills}</span><span class="stage-time">{duration(total)}</span></div>')

    work = union(by_kind['work'] + by_kind['automation'])
    detail = ', '.join(f'{html.escape(reason)} {duration(union(spans))}' for reason, spans in reasons.items())
    breakdown = (f'<p class="time-breakdown"><strong class="time-work">Work + automation {duration(work)}</strong> · '
                 f'<strong class="time-wait">Waiting {duration(union(by_kind["wait"]))}</strong>'
                 + (f' ({detail})' if detail else ''))
    unrecorded = union(by_kind['unrecorded'])
    if unrecorded:
        breakdown += f' · <strong class="time-wait">Wait — reason unrecorded {duration(unrecorded)}</strong>'
    breakdown += '</p>'

    deployed = ''.join(f'<p class="brief">{inline(text)}</p>' for text in spec['deployed'])
    if spec.get('note'):
        deployed += f'<p class="note">{inline(spec["note"])}</p>'
    delegated = ('<ul class="delegated">' + ''.join(
        f'<li><span style="min-width:0;overflow-wrap:anywhere">{inline(item["text"])}</span>'
        + (f'<a href="{html.escape(item["url"], quote=True)}">repair thread</a>' if str(item.get('url', '')).startswith('https://') else '')
        + '</li>' for item in spec['delegated']) + '</ul>') if spec['delegated'] else '<p>None.</p>'
    providers = ''.join(f'<p><strong>🚨🚨 EXTERNAL PROVIDER FAILURE — {inline(text)} — NEEDS FIXING</strong></p>'
                        for text in spec['providers']) or '<p>None.</p>'
    followups = ('<section class="box followup"><h2>FOLLOWUPS</h2>'
                 + ''.join(f'<p>⚠️ {inline(text)}</p>' for text in spec['followups']) + '</section>') if spec['followups'] else ''
    status = ('✅ SHIPPED — ' if spec['shipped'] else '❌ NOT SHIPPED — ') + str(spec['title'])
    values = {
        'status_class': 'green' if spec['shipped'] else 'provider',
        'title': html.escape(status),
        'elapsed': html.escape(f'Elapsed {duration(span)} · {pacific(start)} → {pacific(end)}'),
        'deployed': deployed, 'delegated': delegated, 'providers': providers, 'followups': followups,
        'time_breakdown': breakdown, 'timeline': ''.join(lines),
    }
    page = TEMPLATE.read_text()
    for key, value in values.items():
        page = page.replace('{{' + key + '}}', value)
    need('{{' not in page, 'template placeholder left unfilled')
    return page


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='scripts/deploy scorecard', description=__doc__.split('\n\n')[0])
    parser.add_argument('--spec', type=Path, required=True, help='JSON spec of recorded facts')
    parser.add_argument('--output', type=Path, required=True, help='HTML file to write')
    args = parser.parse_args(argv)
    try:
        page = render(json.loads(args.spec.read_text()))
    except (OSError, ValueError) as error:
        print(f'DEPLOY_SCORECARD FAIL {error}', file=sys.stderr)
        return 1
    args.output.write_text(page)
    print(f'DEPLOY_SCORECARD written={args.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
