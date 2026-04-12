/**
 * STATE MACHINE: OnePagerHeader
 *
 * Stateless - renders logo, title block, and back-to-terminal link.
 *
 * [MOUNTED] --> renders static header content
 */

import { Link } from 'react-router-dom';

import { LOGO_GRADIENT_STOPS, LOGO_PATH } from '../config';

function RoseLabsLogo() {
  return (
    <svg className="w-12 h-12 shrink-0" viewBox="21 62 220 222" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="onepager-logo-gradient" x1="100%" y1="0%" x2="0%" y2="100%">
          {LOGO_GRADIENT_STOPS.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
      </defs>
      <g transform="translate(0,303) scale(0.1,-0.1)" fill="url(#onepager-logo-gradient)">
        <path d={LOGO_PATH} />
      </g>
    </svg>
  );
}

export default function OnePagerHeader() {
  return (
    <>
      <header className="max-w-3xl mx-auto px-8 py-10 flex items-center justify-between">
        <Link
          to="/"
          className="text-sm tracking-wide text-[#8a8680] hover:text-[#1a1a18] transition-colors"
          style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em' }}
        >
          &larr; Back to terminal
        </Link>
      </header>

      <div className="max-w-3xl mx-auto px-8 mb-16 flex items-start gap-8">
        <RoseLabsLogo />
        <div>
          <h1
            className="text-5xl md:text-6xl font-light tracking-tight mb-4"
            style={{ letterSpacing: '-0.02em' }}
          >
            Rose Labs
          </h1>
          <p className="text-lg text-[#6b6860]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
            Frontier Research for Agentic Superintelligence
          </p>
        </div>
      </div>
    </>
  );
}
