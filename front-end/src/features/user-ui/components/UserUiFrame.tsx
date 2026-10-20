/**
 * STATE MACHINE: UserUiFrame
 *
 *   src not an allowed usercontent URL → render nothing (never same-origin,
 *                                        never srcdoc/blob/data)
 *   src allowed → <iframe sandbox="allow-scripts"> on the usercontent origin
 *     [WAITING] --rose:ready--> [READY] host posts rose:props
 *     [READY]   --props change--> host re-posts rose:props
 *     any       --rose:resize--> onResize(height)
 *
 * The sandbox never includes allow-same-origin, so the document runs with an
 * opaque origin and cannot read app cookies, storage or the Supabase session.
 */
import { useRef, type CSSProperties } from 'react';

import { isAllowedUserContentUrl, USER_UI_IFRAME_SANDBOX } from '../config';
import { useUserViewBridge } from '../hooks';

interface UserUiFrameProps {
  src: string;
  title: string;
  props?: unknown;
  onResize?: (height: number) => void;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function UserUiFrame({
  src,
  title,
  props,
  onResize,
  className,
  style,
  testId,
}: UserUiFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const allowed = isAllowedUserContentUrl(src);
  useUserViewBridge({ frameRef, src: allowed ? src : null, props, onResize });
  if (!allowed) return null;
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      sandbox={USER_UI_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      data-testid={testId}
      data-user-ui-frame="true"
      className={className}
      style={{ border: 0, colorScheme: 'normal', ...style }}
    />
  );
}
