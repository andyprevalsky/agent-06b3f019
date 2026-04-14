import { getResearchPosts } from './api';

/** Returns all blog posts in the research category. */
export function useResearchPosts() {
  return getResearchPosts();
}
