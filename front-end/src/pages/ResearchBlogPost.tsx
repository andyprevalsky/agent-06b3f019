/**
 * STATE MACHINE: ResearchBlogPost
 *
 * [MOUNTED] --> reads slug from URL params
 *   |
 *   +--> if post found --> renders breadcrumb, header, ToC (centered), content
 *   +--> if post not found --> renders 404 message
 *
 * State derived from: URL params (slug)
 */

export { default } from '@/features/research-blog-post';
