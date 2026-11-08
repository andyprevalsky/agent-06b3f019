/**
 * Scoped prose styles for MarkdownText: inline code pills, blockquotes,
 * fenced code blocks, paragraph spacing, lists, link colors, and tables
 * (scroll container, whole-word cells).
 */

const MARKDOWN_STYLES = `
  .prose {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .prose p,
  .prose li,
  .prose a,
  .prose span,
  .prose strong,
  .prose em,
  .prose code:not(pre code) {
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .prose code:not(pre code) {
    background-color: rgb(226 232 240);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
    font-weight: 400;
    border: 1px solid rgb(203 213 225);
  }
  .prose code:not(pre code)::before,
  .prose code:not(pre code)::after {
    content: '' !important;
  }
  .dark .prose code:not(pre code) {
    background-color: rgb(255 255 255 / 0.07);
    color: rgb(236 236 232);
    border-color: rgb(255 255 255 / 0.1);
  }

  .custom-blockquote {
    border-left: 4px solid rgb(203 213 225) !important;
    padding-left: 1rem !important;
    font-style: italic !important;
    color: rgb(71 85 105) !important;
    margin: 1.5em 0 !important;
  }
  .dark .custom-blockquote {
    border-left-color: rgb(51 65 85) !important;
    color: rgb(148 163 184) !important;
  }

  .prose blockquote {
    border-left: 4px solid rgb(203 213 225) !important;
    padding-left: 1rem !important;
    font-style: italic !important;
    color: rgb(71 85 105) !important;
    margin: 1.5em 0 !important;
  }
  .dark .prose blockquote {
    border-left-color: rgb(51 65 85) !important;
    color: rgb(148 163 184) !important;
  }

  .prose pre {
    background-color: rgb(241 245 249);
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin: 0.75em 0;
    white-space: pre;
  }
  .dark .prose pre {
    background-color: rgb(0 0 0 / 0.28);
  }
  .prose pre code {
    background-color: transparent;
    padding: 0;
    border: none;
    font-size: 0.875em;
    color: rgb(30 41 59);
    white-space: pre;
  }
  .dark .prose pre code {
    color: rgb(236 236 232);
  }

  .prose.tool-message-markdown pre {
    overflow-x: hidden;
    white-space: pre-wrap;
  }
  .prose.tool-message-markdown pre code {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .prose p {
    margin: 0.25em 0;
  }
  .prose p:first-child {
    margin-top: 0;
  }
  .prose p:last-child {
    margin-bottom: 0;
  }

  .prose ul, .prose ol {
    margin: 0.75em 0;
    padding-left: 1.5em;
    list-style-position: outside;
  }
  .prose li > :is(ul, ol) {
    margin: 0.25em 0;
  }
  .prose ul {
    list-style-type: disc;
  }
  .prose ol {
    list-style-type: decimal;
  }
  .prose li {
    margin: 0.35em 0;
    padding-left: 0.25em;
  }

  .prose a {
    color: rgb(37 99 235);
    text-decoration: none;
  }
  .dark .prose a {
    color: rgb(96 165 250);
  }
  .prose a:hover {
    text-decoration: underline;
  }

  .prose .markdown-table-scroll {
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin: 0.75em 0;
  }
  .prose .markdown-table-scroll table {
    width: 100%;
    margin: 0;
  }
  /* Cells size to whole words; a table wider than the reply scrolls instead. */
  .prose :is(th, td),
  .prose :is(th, td) * {
    overflow-wrap: break-word;
    word-break: normal;
  }
  .prose :is(th, td) {
    vertical-align: top;
  }
  .prose thead,
  .prose tbody tr {
    border-color: rgb(0 0 0 / 0.08);
  }
  .dark .prose thead,
  .dark .prose tbody tr {
    border-color: rgb(255 255 255 / 0.09);
  }

  .prose img {
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
    margin: 0.5em 0;
  }
`;

export function MarkdownStyles(): JSX.Element {
  return <style>{MARKDOWN_STYLES}</style>;
}
