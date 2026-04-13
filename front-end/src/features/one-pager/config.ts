export const ONE_PAGER_TITLE = 'Rose Labs One Pager';
export const ONE_PAGER_DESCRIPTION =
  'Rose Labs investor one pager - Frontier Research for Agentic Superintelligence.';

export const LOGO_GRADIENT_STOPS = [
  { offset: '0%', color: '#FE7503' },
  { offset: '25%', color: '#FC585C' },
  { offset: '50%', color: '#E062CC' },
  { offset: '75%', color: '#A76CED' },
  { offset: '100%', color: '#7A6BEC' },
] as const;

export const LOGO_PATH =
  'M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z';

/** Shared heading styles for section titles. */
export const SECTION_HEADING_STYLE = {
  fontFamily: "'DM Sans', sans-serif",
  letterSpacing: '0.01em',
} as const;

/** Shared serif font family used for the page body. */
export const PAGE_FONT_FAMILY = "'Crimson Pro', Georgia, Cambria, 'Times New Roman', Times, serif";

/** Shared background gradient for the page. */
export const PAGE_BACKGROUND = 'linear-gradient(180deg, #fdfcfa 0%, #f9f7f3 100%)';
