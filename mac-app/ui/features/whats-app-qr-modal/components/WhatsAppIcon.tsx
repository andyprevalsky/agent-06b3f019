/**
 * WhatsApp brand glyph — used only in the WhatsAppQRModal header.
 *
 * This <svg> has no explicit width/height attribute, which is relied on
 * by the blackbox test to distinguish the header icon from the 200×200
 * QR code <svg> via `el.getAttribute('width') === '200'`. Do not add a
 * width/height here without also updating the test selector.
 */

const WhatsAppIcon = ({ className }: { className?: string }): React.ReactElement => (
  <svg className={className} viewBox="0 0 24 24">
    <rect width="24" height="24" rx="5" fill="#25D366" />
    <path
      fill="white"
      d="M12 4c-4.42 0-8 3.58-8 8 0 1.41.37 2.73 1.01 3.88L4 20l4.26-1.12A7.93 7.93 0 0 0 12 20c4.42 0 8-3.58 8-8s-3.58-8-8-8zm4.14 11.07c-.17.48-1 .93-1.38.99-.37.06-.84.09-1.35-.09-.31-.11-.71-.25-1.23-.49-2.16-1-3.57-3.18-3.68-3.33-.1-.15-.86-1.14-.86-2.18s.55-1.55.74-1.76c.2-.21.43-.27.57-.27h.42c.13 0 .31-.05.48.37.18.43.61 1.49.66 1.59.05.1.08.22.02.35-.07.14-.1.22-.2.34-.1.12-.21.26-.3.35-.1.1-.2.2-.09.4.12.2.53.87 1.13 1.41.78.7 1.43.91 1.63 1.02.2.1.32.09.44-.06.12-.14.5-.58.64-.78.13-.2.27-.16.45-.1.18.07 1.15.54 1.34.64.2.1.33.15.38.23.05.09.05.51-.12.99z"
    />
  </svg>
);

export default WhatsAppIcon;
