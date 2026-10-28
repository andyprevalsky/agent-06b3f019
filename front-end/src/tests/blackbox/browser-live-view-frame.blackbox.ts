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
  TILION_LIVE_VIEW_REFRESH_MS,
  TILION_LIVE_VIEW_TOKEN_TTL_MS,
  computeCroppedLiveViewIframe,
  computeLiveViewLetterbox,
  isTilionLiveViewUrl,
  liveViewStreamFitsPane,
  nextHeldTilionLiveView,
  presentHeldLiveViewUrl,
  resolveLiveViewChromeCrop,
  resolveLiveViewDisplaySize,
  resolveLiveViewWindowSize,
  steelLiveViewIframeCropStyle,
  steelLiveViewScaledCropStyle,
  tilionLiveViewSessionId,
  visibleSteelStreamRect,
} from '@/features/terminal-component-group/components/browser-status-bar/liveViewDisplay';

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

  it.each([
    'https://notsteel.example/player',
    'https://steel.dev.example/player',
    'https://connect.steelbrowser.com.example/player',
    'https://example.com/player?provider=steel',
    'https://connect.steel.dev@example.com/player',
    'not a URL containing steel',
  ])('keeps non-Steel or malformed URL %s uncropped', (url) => {
    expect(resolveLiveViewWindowSize(url)).toEqual(KERNEL_LIVE_VIEW_WINDOW);
    expect(resolveLiveViewChromeCrop(url)).toBeNull();
  });

  it.each(['https://CONNECT.STEEL.DEV/player', 'https://connect.steelbrowser.com/player'])(
    'preserves the official Steel player crop for %s',
    (url) => {
      expect(resolveLiveViewWindowSize(url)).toEqual(STEEL_LIVE_VIEW_WINDOW);
      expect(resolveLiveViewChromeCrop(url)?.offsetY).toBe(STEEL_CHROME_CROP.y);
    },
  );
});

describe('Steel chrome crop (display-only)', () => {
  it('excludes the 87px chrome and 4px side/bottom borders from the visible stream rect', () => {
    const crop = resolveLiveViewChromeCrop(STEEL_PLAYER);
    expect(crop).toEqual({
      window: STEEL_LIVE_VIEW_WINDOW,
      content: LIVE_VIEW_CONTENT_VIEWPORT,
      offsetX: STEEL_CHROME_CROP.x,
      offsetY: STEEL_CHROME_CROP.y,
    });
    const visible = visibleSteelStreamRect();
    // Measured on a live 1288x891 Steel session: page origin (4, 87), 4px bottom border.
    expect(visible).toEqual({ x: 4, y: 87, width: 1280, height: 800 });
    expect(visible.y + visible.height + STEEL_CHROME_CROP.x).toBe(STEEL_LIVE_VIEW_WINDOW.height);
    expect(visible.x + visible.width + STEEL_CHROME_CROP.x).toBe(STEEL_LIVE_VIEW_WINDOW.width);
    expect(visible.y).toBeGreaterThan(0);
  });

  it('CSS-scales the native 1288x891 canvas so a right-edge control stays in a leftover pane', () => {
    const style = steelLiveViewIframeCropStyle();
    expect(style.width).toBe('1288px');
    expect(style.height).toBe('891px');
    expect(style.transformOrigin).toBe('top left');
    expect(style.transform).toContain('scale(calc(100cqw / 1280))');
    expect(style.transform).toContain('-4');
    expect(style.transform).toContain('-87');

    const paneWidth = 1100;
    const paneHeight = 700;
    const cartInPageX = 1200;
    const cartStreamX = STEEL_CHROME_CROP.x + cartInPageX;
    expect(cartStreamX).toBeGreaterThan(paneWidth);

    const clip = computeLiveViewLetterbox(
      paneWidth,
      paneHeight,
      LIVE_VIEW_CONTENT_VIEWPORT.width,
      LIVE_VIEW_CONTENT_VIEWPORT.height,
    );
    const crop = resolveLiveViewChromeCrop(STEEL_PLAYER);
    expect(crop).not.toBeNull();
    const iframe = computeCroppedLiveViewIframe(clip, crop!);
    const cartPaneX = iframe.x + cartStreamX * iframe.scale;
    expect(cartPaneX).toBeGreaterThanOrEqual(clip.offsetX);
    expect(cartPaneX).toBeLessThanOrEqual(clip.offsetX + clip.width);

    const scaled = steelLiveViewScaledCropStyle(clip.width);
    expect(scaled.width).toBe('1288px');
    expect(scaled.transform).toBe(
      `translate(${-STEEL_CHROME_CROP.x * iframe.scale}px, ${-STEEL_CHROME_CROP.y * iframe.scale}px) scale(${iframe.scale})`,
    );
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

  it('returns a zero letterbox for a 0×0 mount pane without throwing', () => {
    const { width, height } = LIVE_VIEW_CONTENT_VIEWPORT;
    expect(computeLiveViewLetterbox(0, 0, width, height)).toEqual({
      width: 0,
      height: 0,
      offsetX: 0,
      offsetY: 0,
      scale: 0,
    });
    expect(computeLiveViewLetterbox(0, 700, width, height).width).toBe(0);
    expect(computeLiveViewLetterbox(1100, 0, width, height).height).toBe(0);
  });

  it('still rejects invalid stream dimensions and negative panes', () => {
    const { width, height } = LIVE_VIEW_CONTENT_VIEWPORT;
    expect(() => computeLiveViewLetterbox(1100, 700, 0, height)).toThrow(
      /positive pane and stream dimensions/,
    );
    expect(() => computeLiveViewLetterbox(1100, 700, width, 0)).toThrow(
      /positive pane and stream dimensions/,
    );
    expect(() => computeLiveViewLetterbox(-1, 700, width, height)).toThrow(
      /positive pane and stream dimensions/,
    );
    expect(() => computeLiveViewLetterbox(1100, -1, width, height)).toThrow(
      /positive pane and stream dimensions/,
    );
  });
});

describe('Tilion live-view URL contract', () => {
  const TILION =
    'https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/live-view?token=abc';

  it('recognises Tilion viewer pages as uncropped page-only streams at the session viewport', () => {
    expect(tilionLiveViewSessionId(TILION)).toBe('sess_3d245e56b86d4bc8ae32095b644117d4');
    expect(isTilionLiveViewUrl(TILION)).toBe(true);
    expect(resolveLiveViewChromeCrop(TILION)).toBeNull();
    // Measured: embedded viewer image natural size 1366x625 (windows-low device).
    expect(resolveLiveViewWindowSize(TILION)).toEqual({ width: 1366, height: 625 });
    expect(resolveLiveViewDisplaySize(TILION)).toEqual({ width: 1366, height: 625 });
    expect(resolveLiveViewDisplaySize(KERNEL_LIVE)).toEqual(KERNEL_LIVE_VIEW_WINDOW);
  });

  it.each([
    'https://back.tilion.dev.example/v1/session/s/live-view?token=x',
    'https://back.tilion.dev/v1/session/s/live?token=x',
    'https://back.tilion.dev/v1/session/s/cdp?token=x',
    'https://example.com/v1/session/s/live-view?token=x',
    'not a url',
  ])('rejects non-viewer URL %s', (url) => {
    expect(tilionLiveViewSessionId(url)).toBeNull();
  });

  it('refreshes before the 1800 s token expiry', () => {
    expect(TILION_LIVE_VIEW_TOKEN_TTL_MS).toBe(1_800_000);
    expect(TILION_LIVE_VIEW_REFRESH_MS).toBeLessThan(TILION_LIVE_VIEW_TOKEN_TTL_MS);
    expect(TILION_LIVE_VIEW_REFRESH_MS).toBeGreaterThan(TILION_LIVE_VIEW_TOKEN_TTL_MS / 2);
  });

  it('holds one URL per session until due, then adopts the re-minted URL', () => {
    const first = nextHeldTilionLiveView(null, TILION, 0);
    expect(first).toEqual({
      sessionId: 'sess_3d245e56b86d4bc8ae32095b644117d4',
      url: TILION,
      adoptedAtMs: 0,
    });
    const reminted = TILION.replace('token=abc', 'token=def');
    expect(nextHeldTilionLiveView(first, reminted, 60_000)).toBe(first);
    expect(presentHeldLiveViewUrl(first, reminted)).toBe(TILION);
    const due = nextHeldTilionLiveView(first, reminted, TILION_LIVE_VIEW_REFRESH_MS);
    expect(due?.url).toBe(reminted);
    const other = 'https://back.tilion.dev/v1/session/sess_other/live-view?token=zzz';
    expect(presentHeldLiveViewUrl(first, other)).toBe(other);
    expect(nextHeldTilionLiveView(first, other, 1)?.sessionId).toBe('sess_other');
    expect(nextHeldTilionLiveView(first, STEEL_PLAYER, 1)).toBeNull();
    expect(nextHeldTilionLiveView(first, null, 1)).toBeNull();
    expect(presentHeldLiveViewUrl(null, KERNEL_LIVE)).toBe(KERNEL_LIVE);
  });
});
