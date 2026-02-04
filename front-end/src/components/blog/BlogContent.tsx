/**
 * STATE MACHINE: BlogContent
 *
 * This component is stateless - renders post intro and sections.
 *
 * [MOUNTED] --> renders intro paragraph + all sections
 */

import { BlogPost } from '@/data/blogPosts';

interface BlogContentProps {
  post: BlogPost;
}

export default function BlogContent({ post }: BlogContentProps) {
  return (
    <div className="space-y-12">
      {/* Intro section - no title, not in ToC */}
      <div className="text-lg text-slate-600 leading-relaxed">
        {post.intro.split('\n\n').map((paragraph, i) => (
          <p
            key={i}
            className={i > 0 ? 'mt-4' : ''}
            dangerouslySetInnerHTML={{ __html: paragraph }}
          />
        ))}
      </div>

      {/* Content sections */}
      {post.sections.map((section) => (
        <section key={section.id} id={section.id} className="scroll-mt-24">
          <h2 className="text-2xl font-semibold mb-6 text-slate-900">
            {section.title}
          </h2>
          <div className="text-lg text-slate-600 leading-relaxed space-y-4 [&_a]:text-blue-600 [&_a]:underline [&_a]:hover:text-blue-800">
            {section.content.split('\n\n').map((paragraph, i) => (
              <p key={i} dangerouslySetInnerHTML={{ __html: paragraph }} />
            ))}
          </div>
        </section>
      ))}

      {/* Images if present */}
      {post.images?.map((image, index) => (
        <figure key={index} className="my-8">
          <img
            src={image.src}
            alt={image.alt}
            className="rounded-lg border border-slate-200 w-full"
          />
          {image.caption && (
            <figcaption className="mt-3 text-center text-sm text-slate-500">
              {image.caption}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}
