/**
 * Inline Telegram glyph (brand blue #229ED9 with the paper-plane mark).
 * Duplicated inside the feature rather than pulled from a shared library —
 * the original component embedded the SVG directly and no other feature
 * currently uses this exact artwork.
 */
export const TelegramIcon = ({ className = 'w-6 h-6' }: { className?: string }): JSX.Element => (
  <svg className={className} viewBox="0 0 24 24">
    <rect width="24" height="24" rx="5" fill="#229ED9" />
    <path
      fill="white"
      d="M5.5 11.5l10.7-4.3c.6-.24 1.1.12.9.92l-1.9 9c-.14.64-.52.8-1.06.5l-2.9-2.1-1.4 1.4c-.12.1-.2.2-.4.2-.26 0-.37-.15-.5-.52l-1.1-3.5-2.7-.84c-.32-.11-.34-.41.06-.56zm4.7 1.7l.6 2.55.17-1.85 4.5-4c.2-.18-.05-.27-.32-.1l-5.5 3.4z"
      transform="translate(12, 12) scale(1.05) translate(-12, -12)"
    />
  </svg>
);
