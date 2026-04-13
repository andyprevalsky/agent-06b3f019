import { getBlogPostsByCategory } from '@/features/blog';

/** Returns all blog posts in the research category. */
export function useResearchPosts() {
  return getBlogPostsByCategory('research');
}
