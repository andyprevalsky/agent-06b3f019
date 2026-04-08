/**
 * STATE MACHINE: BlogSidebar
 *
 * This component is stateless - renders category filter links.
 * Only shows "research" category.
 *
 * [MOUNTED] --> renders filter links based on activeCategory prop
 */

import { Link } from 'react-router-dom';

export default function BlogSidebar() {
  return (
    <nav className="space-y-1">
      <Link to="/research" className="block text-sm py-1 text-slate-900 font-medium">
        research
      </Link>
    </nav>
  );
}
