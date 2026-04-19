/**
 * Scoped prose styles for MarkdownText: inline code pills, blockquotes,
 * fenced code blocks, paragraph spacing, lists, and link colors.
 */

const MARKDOWN_STYLES = `
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
    background-color: rgb(30 41 59);
    color: rgb(226 232 240);
    border-color: rgb(51 65 85);
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
    padding: 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin: 1.5em 0;
    white-space: pre;
  }
  .dark .prose pre {
    background-color: rgb(15 23 42);
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
    color: rgb(226 232 240);
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
    margin: 1.5em 0;
    padding-left: 1.5em;
    list-style-position: outside;
  }
  .prose ul {
    list-style-type: disc;
  }
  .prose ol {
    list-style-type: decimal;
  }
  .prose li {
    margin: 0.5em 0;
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
`;

export function MarkdownStyles(): JSX.Element {
  return <style>{MARKDOWN_STYLES}</style>;
}
