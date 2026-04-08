/**
 * STATE MACHINE: ResearchBlog
 *
 * [MOUNTED] --> renders sidebar + post cards (research category only)
 *
 * State: none (stateless component)
 */

import { Link } from 'react-router-dom';
import { getBlogPostsByCategory } from '@/data/blogPosts';
import BlogSidebar from '@/components/blog/BlogSidebar';
import BlogPostCard from '@/components/blog/BlogPostCard';
import NaviFooter from '@/components/NaviFooter';

export default function ResearchBlog() {
  const posts = getBlogPostsByCategory('research');

  return (
    <main
      className="min-h-screen bg-white text-slate-900 flex flex-col"
      style={{
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
      }}
    >
      {/* Header */}
      <div className="max-w-6xl mx-auto px-6 py-8 border-b border-slate-200 w-full flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div
            className="w-8 h-8 rounded-lg"
            style={{
              background:
                'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          />
          <span className="text-xl font-semibold tracking-tight text-slate-900">Rose Labs</span>
        </Link>
        <a
          href="https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg"
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
