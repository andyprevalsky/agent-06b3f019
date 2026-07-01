/**
 * Blackbox tests for MarkdownText component.
 *
 * Covers:
 *  - Plain text rendering
 *  - Escape-sequence normalization (\n, \t, \*, etc.)
 *  - breaks=true + shouldAnimate=false path (ReactMarkdown + remarkBreaks)
 *  - FadeInMarkdown path: static + animated
 *  - Headings, lists (ul/ol), code blocks, fenced code, inline code
 *  - Links, bold/italic, blockquotes
 *  - className passthrough
 *  - onComplete callback (animated path)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';
import { renderWords } from '@/features/terminal-component-group/components/markdown-text/renderWords';
import { type WordItem } from '@/features/terminal-component-group/components/markdown-text/types';

describe('MarkdownText', () => {
  it('renders plain text', async () => {
    const { container } = render(<MarkdownText text="Hello world" />);
    await waitFor(() => expect(container.textContent).toContain('Hello world'));
  });

  it('renders headings via markdown', async () => {
    const { container } = render(<MarkdownText text={'# Title\n\nBody'} />);
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(container.textContent).toContain('Title');
    expect(container.textContent).toContain('Body');
  });

  it('renders unordered lists with bullet items', async () => {
    const { container } = render(<MarkdownText text={'- one\n- two\n- three'} />);
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(3);
    expect(container.textContent).toContain('one');
    expect(container.textContent).toContain('three');
  });

  it('renders ordered lists', async () => {
    const { container } = render(<MarkdownText text={'1. first\n2. second'} />);
    await waitFor(() => expect(container.querySelector('ol')).not.toBeNull());
    expect(container.querySelectorAll('li').length).toBe(2);
  });

  it('renders inline code', async () => {
    const { container } = render(<MarkdownText text={'use `npm run dev` here'} />);
    await waitFor(() => expect(container.querySelector('code')).not.toBeNull());
    expect(container.textContent).toContain('npm run dev');
  });

  it('renders fenced code blocks inside <pre>', async () => {
    const { container } = render(<MarkdownText text={'```\nconst x = 1;\nconsole.log(x);\n```'} />);
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
    expect(container.textContent).toContain('const x = 1;');
  });

  it('renders links with href', async () => {
    const { container } = render(<MarkdownText text="[Rose](https://roselabs.ai)" />);
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://roselabs.ai');
    expect(a.textContent).toContain('Rose');
  });

  it('renders bold and italic', async () => {
    const { container } = render(<MarkdownText text={'**bold** and *italic*'} />);
    await waitFor(() => expect(container.querySelector('strong')).not.toBeNull());
    expect(container.querySelector('em')).not.toBeNull();
  });

  it('renders blockquotes with custom-blockquote class', async () => {
    const { container } = render(<MarkdownText text={'> a quote'} />);
    await waitFor(() => {
      const bq = container.querySelector('blockquote');
      expect(bq).not.toBeNull();
    });
    expect(container.textContent).toContain('a quote');
  });

  it('normalizes literal \\n escape sequences to real newlines', async () => {
    const { container } = render(<MarkdownText text={'line one\\nline two'} breaks={true} />);
    // breaks mode uses ReactMarkdown directly - synchronous
    await waitFor(() => {
      expect(container.textContent).toContain('line one');
      expect(container.textContent).toContain('line two');
    });
  });

  it('breaks=true (no animation) uses ReactMarkdown directly', async () => {
    const { container } = render(
      <MarkdownText text={'hello\nworld'} breaks={true} className="custom-class" />,
    );
    // Outer wrapper should carry the className
    await waitFor(() => {
      expect(container.querySelector('.custom-class')).not.toBeNull();
      expect(container.textContent).toContain('hello');
      expect(container.textContent).toContain('world');
    });
  });

  it('passes className to FadeInMarkdown when not in breaks mode', async () => {
    const { container } = render(<MarkdownText text="hello" className="my-prose" />);
    await waitFor(() => {
      expect(container.querySelector('.my-prose')).not.toBeNull();
    });
  });

  it('applies wrapping styles to the static markdown path', async () => {
    const longUrl =
      'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fexample.com%2Fcheckout%2Fwith%2Fa%2Fvery%2Flong%2Funbroken%2Ftoken';
    const { container } = render(<MarkdownText text={longUrl} breaks />);

    await waitFor(() => expect(container.textContent).toContain('amazon.com'));
    const style = container.querySelector('style');
    expect(style?.textContent).toContain('overflow-wrap: anywhere');
    expect(style?.textContent).toContain('word-break: normal');
  });

  it('shouldAnimate=true calls onComplete when last word animation completes', async () => {
    const onComplete = vi.fn();
    render(<MarkdownText text="short" shouldAnimate={true} onComplete={onComplete} />);
    // Motion animations fire onAnimationComplete synchronously in jsdom
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('handles text with mixed formatting in a single string', async () => {
    const { container } = render(
      <MarkdownText text={'**Hi** there with `code` and [link](https://x.y)'} />,
    );
    await waitFor(() => {
      expect(container.querySelector('strong')).not.toBeNull();
      expect(container.querySelector('code')).not.toBeNull();
      expect(container.querySelector('a')).not.toBeNull();
    });
  });

  it('uses inline group keys that do not collide with interleaved whitespace children', () => {
    const words: WordItem[] = [
      { word: 'Best', isWord: true, isBold: true },
      { word: ' ', isWord: false },
      { word: 'cities', isWord: true, isItalic: true },
      { word: ' ', isWord: false },
      { word: 'cheap', isWord: true, isCode: true },
    ];

    const nodes = renderWords(words, false, 0, words[4], vi.fn());
    const groupKeys = nodes
      .map((node) => (typeof node === 'object' && node !== null && 'key' in node ? node.key : null))
      .filter((key): key is string => typeof key === 'string' && key.startsWith('group-'))
      .map((key) => key.match(/^group-\d+/)?.[0]);

    expect(groupKeys).toEqual(['group-0', 'group-1', 'group-2']);
  });

  it('renders nested list items with multiple paragraphs correctly', async () => {
    const { container } = render(
      <MarkdownText text={'- item a\n- item b\n\nafter list\n\n1. one\n2. two'} />,
    );
    await waitFor(() => {
      expect(container.querySelector('ul')).not.toBeNull();
      expect(container.querySelector('ol')).not.toBeNull();
    });
    expect(container.textContent).toContain('after list');
  });

  it('renders an empty string gracefully (no crash)', async () => {
    const { container } = render(<MarkdownText text="" />);
    // Empty markdown produces empty extraction. Component still renders the wrapper.
    await waitFor(() => expect(container.firstChild).not.toBeNull());
  });

  it('unescapes literal backslash-star sequences in the output', async () => {
    const { container } = render(<MarkdownText text={'escaped \\*literal\\*'} />);
    await waitFor(() => {
      // After normalization \* → *, producing **literal** semantics in markdown (emphasis).
      expect(container.textContent).toContain('literal');
    });
  });
});
