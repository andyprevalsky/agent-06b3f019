/**
 * STATE MACHINE: CareersHeader
 *
 * This component is stateless - it renders the brand mark, an optional
 * breadcrumb back to /careers, and the download CTA.
 *
 * [MOUNTED] --> renders header
 */

import { Link } from 'react-router-dom';

import { DOWNLOAD_URL, LOGO_GRADIENT } from '../config';

interface CareersHeaderProps {
  /** When true, renders a "Careers" breadcrumb link back to the overview page. */
  showBackLink?: boolean;
}

export default function CareersHeader({ showBackLink = false }: CareersHeaderProps) {
  return (
    <div className="border-b border-slate-200 w-full">
      <div className="max-w-6xl mx-auto px-6 py-6 sm:py-8 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity min-w-0"
          >
            <div
              className="w-8 h-8 rounded-lg flex-shrink-0"
              style={{ background: LOGO_GRADIENT }}
            />
            <span className="text-lg sm:text-xl font-semibold tracking-tight text-slate-900 truncate">
              Rose Labs
            </span>
          </Link>
          {showBackLink && (
            <>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <Link
                to="/careers"
                className="text-sm text-slate-500 hover:text-slate-900 transition-colors hidden sm:inline"
              >
                Careers
              </Link>
            </>
          )}
        </div>
        <a
          href={DOWNLOAD_URL}
          className="flex-shrink-0 px-4 py-2 text-sm font-medium text-white rounded-lg bg-navi-black hover:bg-navi-black/90 transition-colors"
        >
          Download
        </a>
      </div>
    </div>
  );
}
