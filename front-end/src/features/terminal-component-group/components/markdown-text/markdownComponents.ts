/**
 * The one ReactMarkdown component map. MarkdownText's static path and
 * FadeInMarkdown render the same tree with it, so a reply keeps its tables,
 * links and images whether it is fading in or settled.
 */
import type { Components } from 'react-markdown';

import { MarkdownImage } from './MarkdownImage';
import { MarkdownLink } from './MarkdownLink';
import { MarkdownTable } from './MarkdownTable';

export const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: MarkdownTable,
};
