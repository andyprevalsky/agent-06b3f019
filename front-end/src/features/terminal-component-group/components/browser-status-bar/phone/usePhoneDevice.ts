/**
 * STATE MACHINE: usePhoneDevice (read-only device view; never touches the lease queue)
 *
 *   [HIDDEN | unmounted] no timers, no requests, frame URL revoked
 *   [VISIBLE] --GET /iphone/device every DEVICE_POLL_MS--> device { enabled, providerState,
 *             holder, waiting }
 *     providerState STARTING|READY (enabled) --> frame loop: GET /iphone/device/frame every
 *       FRAME_POLL_MS, single-flight (next read starts only after the previous settles)
 *         200 image/png  --> [FRAME] new object URL (previous revoked)
 *         409 busy       --> keep the last frame
 *         409 private    --> drop the frame ("private")
 *         409 IDLE|STARTING|CLOSING --> drop the frame, show that provider state
 *     providerState IDLE|CLOSING or disabled --> frame loop idles; frame dropped
 *   Request errors keep polling and keep the last frame (transient); no lease is allocated.
 */
import { useEffect, useState } from 'react';
import {
  readIPhoneDevice,
  readIPhoneDeviceFrame,
  type IPhoneDevice,
  type IPhoneDeviceFrame,
} from '@/lib/api/iphone';

/** Agent ids shown in phone banners ("In use by agent abcd1234"). */
export const shortAgentId = (agentId: string) => agentId.slice(0, 8);

export const DEVICE_POLL_MS = 3_000;
export const FRAME_POLL_MS = 1_000;

type FrameState = 'frame' | Extract<IPhoneDeviceFrame, { kind: 'unavailable' }>['state'];

export interface PhoneDeviceModel {
  device: IPhoneDevice | null;
  /** Object URL of the latest live screen, or null. */
  frame: string | null;
  frameState: FrameState | null;
  error: boolean;
}

const EMPTY: PhoneDeviceModel = { device: null, frame: null, frameState: null, error: false };

const streaming = (device: IPhoneDevice | null) =>
  device !== null &&
  device.enabled &&
  (device.providerState === 'READY' || device.providerState === 'STARTING');

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return visible;
}

export function usePhoneDevice(): PhoneDeviceModel {
  const visible = usePageVisible();
  const [model, setModel] = useState<PhoneDeviceModel>(EMPTY);
  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let state: PhoneDeviceModel = EMPTY;
    let deviceTimer: ReturnType<typeof setTimeout> | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let frameInFlight = false;
    const publish = (next: Partial<PhoneDeviceModel>) => {
      if (signal.aborted) return;
      state = { ...state, ...next };
      setModel(state);
    };
    const dropFrame = (frameState: FrameState | null) => {
      if (state.frame) URL.revokeObjectURL(state.frame);
      publish({ frame: null, frameState });
    };
    const applyFrame = (result: IPhoneDeviceFrame) => {
      if (result.kind === 'frame') {
        const url = URL.createObjectURL(result.blob);
        if (state.frame) URL.revokeObjectURL(state.frame);
        publish({ frame: url, frameState: 'frame', error: false });
      } else if (result.state === 'busy') publish({ frameState: 'busy' });
      else dropFrame(result.state);
    };
    const readFrame = async () => {
      frameTimer = undefined;
      if (signal.aborted || frameInFlight) return;
      if (streaming(state.device)) {
        frameInFlight = true;
        try {
          applyFrame(await readIPhoneDeviceFrame(signal));
        } catch {
          publish({ error: true });
        } finally {
          frameInFlight = false;
        }
      }
      if (!signal.aborted) frameTimer = setTimeout(() => void readFrame(), FRAME_POLL_MS);
    };
    const readDevice = async () => {
      try {
        const device = await readIPhoneDevice(signal);
        publish({ device, error: false });
        if (!streaming(device) && state.frame !== null) dropFrame(null);
        // First streaming observation: fetch a frame now instead of waiting a tick.
        if (streaming(device) && !frameInFlight && state.frameState === null) {
          clearTimeout(frameTimer);
          void readFrame();
        }
      } catch {
        publish({ error: true });
      }
      if (!signal.aborted) deviceTimer = setTimeout(() => void readDevice(), DEVICE_POLL_MS);
    };
    void readDevice();
    frameTimer = setTimeout(() => void readFrame(), FRAME_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(deviceTimer);
      clearTimeout(frameTimer);
      if (state.frame) URL.revokeObjectURL(state.frame);
      setModel(EMPTY);
    };
  }, [visible]);
  return model;
}
