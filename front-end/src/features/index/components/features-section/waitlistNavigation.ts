/**
 * Navigation helper used by the Features section to jump to the
 * waitlist or pre-order sections. When we're already on the root
 * page we smooth-scroll to the anchor; otherwise we navigate to
 * the root with the appropriate hash.
 */
export function navigateToWaitlistOrPreOrder(earlyAccess: boolean): void {
  const targetId = earlyAccess ? 'pre-order' : 'waitlist';
  if (window.location.pathname === '/') {
    document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  window.location.href = earlyAccess ? `/?earlyaccess#${targetId}` : `/#${targetId}`;
}
