import { useParams } from 'react-router-dom';

import { fetchBlogPostBySlug } from './api';

/** Reads the slug from URL params and returns the matching blog post (or undefined). */
export function useBlogPost() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? fetchBlogPostBySlug(slug) : undefined;
}
