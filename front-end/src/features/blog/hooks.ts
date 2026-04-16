// No React hooks needed for the blog feature.
// Blog components are stateless UI that receive data via props.
// Data fetching hooks live in consumer features (research-blog, research-blog-post).

/** Format a date string (YYYY-MM-DD) to localized display format (e.g. "Mar 22, 2026"). */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
