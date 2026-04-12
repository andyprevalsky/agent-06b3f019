import { type BlogCategory, type BlogPost } from './types';
import { blogPosts } from './config';

export function getBlogPost(slug: string): BlogPost | undefined {
  return blogPosts.find((post) => post.slug === slug);
}

export function getBlogPostsByCategory(category: BlogCategory | 'all'): BlogPost[] {
  if (category === 'all') return blogPosts;
  return blogPosts.filter((post) => post.category === category);
}
