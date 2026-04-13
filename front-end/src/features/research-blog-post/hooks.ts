import { useParams } from 'react-router-dom';
import { getBlogPost } from '@/features/blog';

/** Reads the slug from URL params and returns the matching blog post (or undefined). */
export function useBlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getBlogPost(slug) : undefined;
  return post;
}
