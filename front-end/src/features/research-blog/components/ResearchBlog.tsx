/**
 * STATE MACHINE: ResearchBlog
 *
 * [MOUNTED] --> renders sidebar + post cards (research category only)
 *
 * State: none (stateless component)
 */

import { Link } from 'react-router-dom';
import { BlogSidebar, BlogPostCard } from '@/features/blog';
import NaviFooter from '@/components/NaviFooter';

import { DOWNLOAD_URL, LOGO_GRADIENT, FONT_FAMILY } from '../config';
import { useResearchPosts } from '../hooks';

export default function ResearchBlog() {
  const posts = useResearchPosts();

  return (
    <main
      className="min-h-screen bg-white text-slate-900 flex flex-col"
      style={{ fontFamily: FONT_FAMILY }}
    >
      {/* Header */}
      <div className="max-w-6xl mx-auto px-6 py-8 border-b border-slate-200 w-full flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded-lg" style={{ background: LOGO_GRADIENT }} />
          <span className="text-xl font-semibold tracking-tight text-slate-900">Rose Labs</span>
        </Link>
        <a
          href={DOWNLOAD_URL}
          className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-navi-black hover:bg-navi-black/90 transition-colors"
        >
          Download
        </a>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-16 flex-1 w-full" style={{ minHeight: '100vh' }}>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-12">
          {/* Sidebar */}
          <aside className="md:col-span-3 lg:col-span-2">
            <BlogSidebar />
          </aside>

          {/* Post list */}
          <div className="md:col-span-9 lg:col-span-10">
            <div className="space-y-6">
              {posts.map((post) => (
                <BlogPostCard key={post.slug} post={post} />
              ))}
              {posts.length === 0 && <p className="text-slate-500">No posts yet.</p>}
            </div>
          </div>
        </div>
      </div>

      <NaviFooter />
    </main>
  );
}
