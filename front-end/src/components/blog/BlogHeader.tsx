/**
 * STATE MACHINE: BlogHeader
 *
 * This component is stateless - renders post title and metadata.
 *
 * [MOUNTED] --> renders header with title, date, author
 */

import { BlogPost, formatDate } from '@/data/blogPosts';

interface BlogHeaderProps {
  post: BlogPost;
}

export default function BlogHeader({ post }: BlogHeaderProps) {
  return (
    <header className="space-y-4">
      <h1 className="text-4xl md:text-5xl font-semibold leading-tight text-slate-900">
        {post.title}
      </h1>
      <p className="text-sm text-slate-500">
        {formatDate(post.date)} by {post.author}
      </p>
    </header>
  );
}
