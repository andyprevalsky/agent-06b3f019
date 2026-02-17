/**
 * STATE MACHINE: ResearchBlogPost
 *
 * [MOUNTED] --> reads slug from URL params
 *   |
 *   +--> if post found --> renders breadcrumb, header, ToC (centered), content
 *   +--> if post not found --> renders 404 message
 *
 * State derived from: URL params (slug)
 */

import { useParams, Link } from 'react-router-dom';
import { getBlogPost } from '@/data/blogPosts';
import BlogBreadcrumb from '@/components/blog/BlogBreadcrumb';
import BlogHeader from '@/components/blog/BlogHeader';
import BlogTableOfContents from '@/components/blog/BlogTableOfContents';
import BlogContent from '@/components/blog/BlogContent';
import NaviFooter from '@/components/NaviFooter';

export default function ResearchBlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getBlogPost(slug) : undefined;

  if (!post) {
    return (
      <main
        className="min-h-screen bg-white text-slate-900 flex items-center justify-center"
        style={{
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
        }}
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-slate-900 mb-4">Post not found</h1>
          <Link to="/research" className="text-slate-600 hover:text-slate-900 underline">
            Back to all posts
          </Link>
        </div>
      </main>
    );
  }

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

      {/* Content - all centered */}
      <article className="max-w-3xl mx-auto px-6 py-12 flex-1 w-full">
        {/* Breadcrumb */}
        <div className="mb-8">
          <BlogBreadcrumb category={post.category} />
        </div>

        {/* Header - centered */}
        <div className="mb-8">
          <BlogHeader post={post} />
        </div>

        {/* Table of Contents - centered accordion */}
        <div className="mb-12">
          <BlogTableOfContents sections={post.sections} />
        </div>

        {/* Content */}
        <BlogContent post={post} />
      </article>

      <NaviFooter />
    </main>
  );
}
