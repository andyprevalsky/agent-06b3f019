import { getBlogPostsByCategory } from '@/features/blog';

import { type BlogPost } from './types';
import { RESEARCH_CATEGORY } from './config';

/** Fetch all blog posts in the research category. */
export function getResearchPosts(): BlogPost[] {
  return getBlogPostsByCategory(RESEARCH_CATEGORY);
}
