/**
 * STATE MACHINE: BlogBreadcrumb
 *
 * This component is stateless - renders breadcrumb navigation.
 *
 * [MOUNTED] --> renders breadcrumb links
 */

import { Link } from 'react-router-dom';
import { BlogCategory } from '@/data/blogPosts';

interface BlogBreadcrumbProps {
  category: BlogCategory;
}

export default function BlogBreadcrumb({ category }: BlogBreadcrumbProps) {
  return (
    <nav className="text-sm text-slate-500">
      <Link to="/research" className="hover:text-slate-700 transition-colors">
        Blog
      </Link>
      <span className="mx-2">/</span>
      <Link
        to="/research"
        className="text-slate-400 hover:text-slate-700 transition-colors capitalize"
      >
        {category}
      </Link>
    </nav>
  );
}
