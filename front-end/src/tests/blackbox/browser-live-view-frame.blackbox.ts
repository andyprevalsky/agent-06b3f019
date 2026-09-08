/**
 * Owning-boundary repro for off-center live view.
 *
 * Agent 3b2a912a-0248-478a-a4b9-0693a4983d75: Steel live views showed the
 * full 1288x891 computer window (toolbar + borders), so page content looked
 * off-center / hanging outside the window. Display must crop to 1280x800
 * without resizing the remote session (antibot).
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_LIVE_VIEW_WINDOW,
  LIVE_VIEW_CONTENT_VIEWPORT,
  STEEL_CHROME_CROP,
  STEEL_LIVE_VIEW_WINDOW,
  computeCroppedLiveViewIframe,
  computeLiveViewLetterbox,
  liveViewStreamFitsPane,
  resolveLiveViewChromeCrop,
  resolveLiveViewDisplaySize,
  resolveLiveViewWindowSize,
  steelLiveViewIframeCropStyle,
  visibleSteelStreamRect,
} from '@/features/terminal-component-group/components/browser-status-bar/liveViewFrame';

const STEEL_PLAYER =
  'https://connect.steel.dev/v1/sessions/ef622b64-21ae-49c3-862b-b615e4ba9e52/player?interactive=false';
const KERNEL_LIVE =
  'https://prod-jfk-hypeman-10.kernel.sh:8443/browser/live/ypgByetzw9pF?readOnly=true';

describe('live-view window vs display contract', () => {
  it('keeps the Steel remote window at 1288x891 (antibot session size)', () => {
    expect(resolveLiveViewWindowSize(STEEL_PLAYER)).toEqual(STEEL_LIVE_VIEW_WINDOW);
    expect(resolveLiveViewWindowSize(STEEL_PLAYER)).not.toEqual({ width: 1440, height: 900 });
  });

  it('frames the user-visible Steel clip as the 1280x800 content viewport, not the chrome window', () => {
    expect(resolveLiveViewDisplaySize(STEEL_PLAYER)).toEqual(LIVE_VIEW_CONTENT_VIEWPORT);
    expect(resolveLiveViewDisplaySize(STEEL_PLAYER)).not.toEqual(STEEL_LIVE_VIEW_WINDOW);
    expect(
      resolveLiveViewDisplaySize(STEEL_PLAYER).width /
        resolveLiveViewDisplaySize(STEEL_PLAYER).height,
    ).toBeCloseTo(16 / 10, 5);
  });

  it('maps Kernel live-view URLs to a 1280x800 window with no chrome crop', () => {
    expect(resolveLiveViewWindowSize(KERNEL_LIVE)).toEqual(KERNEL_LIVE_VIEW_WINDOW);
    expect(resolveLiveViewDisplaySize(KERNEL_LIVE)).toEqual(LIVE_VIEW_CONTENT_VIEWPORT);
    expect(resolveLiveViewChromeCrop(KERNEL_LIVE)).toBeNull();
  });
});

describe('Steel chrome crop (display-only)', () => {
  it('excludes the 91px toolbar and 4px side borders from the visible stream rect', () => {
    const crop = resolveLiveViewChromeCrop(STEEL_PLAYER);
    expect(crop).toEqual({
      window: STEEL_LIVE_VIEW_WINDOW,
      content: LIVE_VIEW_CONTENT_VIEWPORT,
      offsetX: STEEL_CHROME_CROP.x,
      offsetY: STEEL_CHROME_CROP.y,
    });
    const visible = visibleSteelStreamRect();
    expect(visible).toEqual({ x: 4, y: 91, width: 1280, height: 800 });
    expect(visible.y + visible.height).toBe(STEEL_LIVE_VIEW_WINDOW.height);
    expect(visible.x + visible.width + STEEL_CHROME_CROP.x).toBe(STEEL_LIVE_VIEW_WINDOW.width);
    expect(visible.y).toBeGreaterThan(0);
  });

  it('sizes the Steel iframe larger than the clip and translates it by the chrome origin', () => {
    const style = steelLiveViewIframeCropStyle();
    expect(parseFloat(style.width)).toBeCloseTo((1288 / 1280) * 100);
    expect(parseFloat(style.height)).toBeCloseTo((891 / 800) * 100);
    expect(parseFloat(style.left)).toBeCloseTo((-4 / 1280) * 100);
    expect(parseFloat(style.top)).toBeCloseTo((-91 / 800) * 100);
    expect(parseFloat(style.top)).toBeLessThan(0);
    expect(parseFloat(style.left)).toBeLessThan(0);
  });

  it('keeps the cropped content box inside a leftover 16:9 pane', () => {
    const paneWidth = 1600;
    const paneHeight = 900;
    const { width, height } = LIVE_VIEW_CONTENT_VIEWPORT;
    expect(liveViewStreamFitsPane(paneWidth, paneHeight, width, height)).toBe(true);
    const clip = computeLiveViewLetterbox(paneWidth, paneHeight, width, height);
    const crop = resolveLiveViewChromeCrop(STEEL_PLAYER);
    expect(crop).not.toBeNull();
    const iframe = computeCroppedLiveViewIframe(clip, crop!);
    expect(clip.height).toBeLessThanOrEqual(paneHeight);
    expect(clip.width).toBeLessThanOrEqual(paneWidth);
    expect(clip.width / clip.height).toBeCloseTo(width / height);
    expect(iframe.y).toBeLessThan(clip.offsetY);
    expect(iframe.x).toBeLessThan(clip.offsetX);
  });

  it('letterboxes content inside the 8:5 mobile reservation without overflow', () => {
    const paneWidth = 390;
    const paneHeight = (390 * 5) / 8;
    const { width, height } = LIVE_VIEW_CONTENT_VIEWPORT;
    expect(liveViewStreamFitsPane(paneWidth, paneHeight, width, height)).toBe(true);
    const box = computeLiveViewLetterbox(paneWidth, paneHeight, width, height);
    expect(box.width).toBeCloseTo(paneWidth);
    expect(box.height).toBeCloseTo(paneHeight);
    expect(box.offsetX).toBeCloseTo(0);
    expect(box.offsetY).toBeCloseTo(0);
  });
});
