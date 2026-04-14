import { type BlogPost, getBlogPost } from '@/features/blog';

/** Look up a blog post by its URL slug. Returns undefined when no match is found. */
export function fetchBlogPostBySlug(slug: string): BlogPost | undefined {
  return getBlogPost(slug);
}
