/**
 * Host side of the postMessage bridge for one sandboxed user frame.
 *
 *   [WAITING] --rose:ready--> [READY] (host posts {type:'rose:props', props})
 *   [READY]   --props change--> re-post rose:props
 *   any state --rose:resize--> onResize(height)
 *
 * A message is accepted only when `event.source` is this frame's
 * contentWindow AND its origin is the frame's usercontent origin or `"null"`
 * (the opaque origin a `sandbox="allow-scripts"` document reports). Messages
 * from any other window, origin or shape are ignored.
 */
import { useEffect, useRef, type RefObject } from 'react';

import { parseViewMessage, userContentOrigin } from '../config';

const OPAQUE_SANDBOX_ORIGIN = 'null';

interface BridgeOptions {
  frameRef: RefObject<HTMLIFrameElement>;
  src: string | null;
  props?: unknown;
  onResize?: (height: number) => void;
}

export function isTrustedViewMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
  expectedOrigin: string | null,
): boolean {
  if (!frame || !frame.contentWindow) return false;
  if (event.source !== frame.contentWindow) return false;
  return event.origin === OPAQUE_SANDBOX_ORIGIN || event.origin === expectedOrigin;
}

function postProps(frame: HTMLIFrameElement | null, props: unknown) {
  // The sandboxed document has an opaque origin, so '*' is the only target
  // that reaches it; the payload is this view's own props.
  frame?.contentWindow?.postMessage({ type: 'rose:props', props: props ?? null }, '*');
}

export function useUserViewBridge({ frameRef, src, props, onResize }: BridgeOptions) {
  const readyRef = useRef(false);
  const propsRef = useRef(props);
  const onResizeRef = useRef(onResize);
  propsRef.current = props;
  onResizeRef.current = onResize;

  useEffect(() => {
    readyRef.current = false;
    if (!src) return;
    const expectedOrigin = userContentOrigin(src);
    const onMessage = (event: MessageEvent) => {
      if (!isTrustedViewMessage(event, frameRef.current, expectedOrigin)) return;
      const message = parseViewMessage(event.data);
      if (!message) return;
      if (message.type === 'rose:ready') {
        readyRef.current = true;
        postProps(frameRef.current, propsRef.current);
        return;
      }
      onResizeRef.current?.(message.height);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, src]);

  useEffect(() => {
    if (readyRef.current) postProps(frameRef.current, props);
  }, [frameRef, props]);
}
