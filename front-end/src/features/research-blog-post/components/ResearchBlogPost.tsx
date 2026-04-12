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

import { Link } from 'react-router-dom';
import { BlogBreadcrumb, BlogHeader, BlogTableOfContents, BlogContent } from '@/features/blog';
import NaviFooter from '@/components/NaviFooter';

import {
  BLOG_POST_FONT_FAMILY,
  ROSE_LABS_GRADIENT,
  DOWNLOAD_DMG_URL,
  RESEARCH_INDEX_PATH,
} from '../config';
import { useBlogPost } from '../hooks';

export default function ResearchBlogPost() {
  const post = useBlogPost();

  if (!post) {
    return (
      <main
        className="min-h-screen bg-white text-slate-900 flex items-center justify-center"
        style={{ fontFamily: BLOG_POST_FONT_FAMILY }}
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-slate-900 mb-4">Post not found</h1>
          <Link to={RESEARCH_INDEX_PATH} className="text-slate-600 hover:text-slate-900 underline">
            Back to all posts
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen bg-white text-slate-900 flex flex-col"
      style={{ fontFamily: BLOG_POST_FONT_FAMILY }}
    >
      {/* Header */}
      <div className="max-w-6xl mx-auto px-6 py-8 border-b border-slate-200 w-full flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded-lg" style={{ background: ROSE_LABS_GRADIENT }} />
          <span className="text-xl font-semibold tracking-tight text-slate-900">Rose Labs</span>
        </Link>
        <a
          href={DOWNLOAD_DMG_URL}
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
