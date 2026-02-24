// Minimal blog metadata for OG social card generation.
// IMPORTANT: Keep in sync with front-end/src/data/blogPosts.ts

export interface BlogMeta {
  slug: string;
  title: string;
  description: string;
  category: string;
  date: string;
  author: string;
}

export const blogMeta: BlogMeta[] = [
  {
    slug: 'task-decomposer',
    title: 'Why task decomposition is the bottleneck to superintelligence & how we built a SOTA generalizable task decomposer',
    description: 'How we built a flexible task decomposition layer that enables agents to complete complex, multi-step tasks across diverse domains.',
    category: 'research',
    date: '2026-02-23',
    author: 'Andy Prevalsky',
  },
];

export function getBlogMeta(slug: string): BlogMeta | undefined {
  return blogMeta.find((post) => post.slug === slug);
}
