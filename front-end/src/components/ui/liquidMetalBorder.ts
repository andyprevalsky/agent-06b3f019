/**
 * The integration ("interface") icons' liquid-metal ring: a diagonal black/white
 * conic gradient on a 1px transparent border (border-box) under a solid `fill`
 * (padding-box). Shared by the integrations DropdownIconFrame and the Rose left
 * bar's pending-project icon.
 */
export const liquidMetalBorderBackground = (fill: string): string =>
  `linear-gradient(${fill}, ${fill}) padding-box, conic-gradient(from 45deg, rgba(16,16,16,0.9) 0deg, rgba(255,255,255,0.96) 90deg, rgba(16,16,16,0.9) 180deg, rgba(255,255,255,0.96) 270deg, rgba(16,16,16,0.9) 360deg) border-box`;

/** Rose glow (ROSE_GRADIENT tints) around a framed icon: synced integrations, mac-app onboarding ring, pending project. */
export const roseIconGlowGradient =
  'linear-gradient(to bottom left, rgba(254, 117, 3, 0.5), rgba(252, 88, 92, 0.45), rgba(224, 98, 204, 0.45), rgba(122, 107, 236, 0.5))';
