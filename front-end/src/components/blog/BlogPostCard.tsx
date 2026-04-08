/**
 * STATE MACHINE: BlogPostCard
 *
 * This component is stateless - renders a clickable post card.
 *
 * [MOUNTED] --> renders post preview card with slightly darker background
 */

import { Link } from 'react-router-dom';
import { BlogPost, formatDate } from '@/data/blogPosts';

interface BlogPostCardProps {
  post: BlogPost;
}

export default function BlogPostCard({ post }: BlogPostCardProps) {
  return (
    <Link to={`/research/${post.slug}`} className="block group">
      <article className="p-6 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors space-y-3">
        <h2 className="text-xl font-semibold text-slate-900 group-hover:text-slate-700 transition-colors leading-tight">
          {post.title}
        </h2>
        <p className="text-base text-slate-600 leading-relaxed">{post.description}</p>
        <p className="text-sm text-slate-500">
          <span className="text-slate-600">{post.category}</span>
          <span className="mx-2">·</span>
          {formatDate(post.date)}
        </p>
      </article>
    </Link>
  );
}
