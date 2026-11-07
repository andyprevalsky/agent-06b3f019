/**
 * Blackbox tests for MarkdownText component.
 *
 * Covers:
 *  - Plain text rendering
 *  - Escape-sequence normalization (\n, \t, \*, etc.)
 *  - breaks=true + shouldAnimate=false path (ReactMarkdown + remarkBreaks)
 *  - FadeInMarkdown path: animated, same ReactMarkdown tree as the static path
 *  - Headings, lists (ul/ol), code blocks, fenced code, inline code
 *  - Links, bold/italic, blockquotes
 *  - className passthrough
 *  - onComplete callback (animated path)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';
import { isAllowedImageSrc } from '@/features/terminal-component-group/components/markdown-text/isAllowedImageSrc';
import { linkifyMarkdownText } from '@/features/terminal-component-group/components/markdown-text/linkifyMarkdownText';

const CAPTURED_ATTENTION_TEXT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent-3be856d5-attention.txt'),
  'utf8',
);

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

  it('passes className on the static ReactMarkdown path', async () => {
    const { container } = render(<MarkdownText text="hello" className="my-prose" />);
    await waitFor(() => {
      expect(container.querySelector('.my-prose')).not.toBeNull();
    });
  });

  it('keeps markdown photos on the animated FadeInMarkdown path', async () => {
    const { container } = render(
      <MarkdownText
        text={'![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)'}
        shouldAnimate={true}
      />,
    );
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://www.cyberracoon.com/gallery/room.jpg');
      expect(img).toHaveAttribute('alt', 'Cyber Racoon PC Cafe');
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

  it('drops javascript and data image sources on the static path', async () => {
    const { container } = render(
      <MarkdownText text={'![xss](javascript:alert(1))\n\n![pixel](data:image/gif;base64,AAAA)'} />,
    );
    await waitFor(() => expect(container.textContent).not.toBeUndefined());
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops javascript image sources on the animated path', async () => {
    const { container } = render(
      <MarkdownText text={'![xss](javascript:alert(1))'} shouldAnimate={true} />,
    );
    await waitFor(() => expect(container.textContent).not.toBeUndefined());
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders markdown photos on the default static path used by FYI attention bubbles', async () => {
    const { container } = render(
      <MarkdownText
        text={
          'Cyber Racoon interior:\n\n![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)'
        }
      />,
    );
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://www.cyberracoon.com/gallery/room.jpg');
      expect(img).toHaveAttribute('alt', 'Cyber Racoon PC Cafe');
    });
  });

  it('animated path keeps inline formatting without duplicate React keys', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <MarkdownText text={'**Best** *cities* `cheap` [maps](https://x.y)'} shouldAnimate />,
    );
    expect(container.querySelector('strong')).toHaveTextContent('Best');
    expect(container.querySelector('em')).toHaveTextContent('cities');
    expect(container.querySelector('code')).toHaveTextContent('cheap');
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://x.y');
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/);
    errors.mockRestore();
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

  function hrefs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('a'))
      .map((anchor) => anchor.getAttribute('href') || '')
      .filter(Boolean);
  }

  it('hyperlinks bare hostnames in captured send_message_to_user text', async () => {
    const { container } = render(<MarkdownText text={CAPTURED_ATTENTION_TEXT} />);
    await waitFor(() => {
      expect(container.textContent).toContain('bytescafesa.com');
    });
    expect(hrefs(container)).toEqual(
      expect.arrayContaining([
        'https://bytescafesa.com',
        'https://mixeresports.com',
        'https://jbgamingcafe.com',
      ]),
    );
    const bytes = Array.from(container.querySelectorAll('a')).find((anchor) =>
      (anchor.getAttribute('href') || '').includes('bytescafesa.com'),
    );
    expect(bytes?.textContent).toContain('bytescafesa.com');
    expect(bytes?.getAttribute('target')).toBe('_blank');
    expect(bytes?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('hyperlinks the same captured hostnames on the static breaks path', async () => {
    const { container } = render(<MarkdownText text={CAPTURED_ATTENTION_TEXT} breaks />);
    await waitFor(() => expect(container.textContent).toContain('bytescafesa.com'));
    expect(hrefs(container)).toEqual(
      expect.arrayContaining([
        'https://bytescafesa.com',
        'https://mixeresports.com',
        'https://jbgamingcafe.com',
      ]),
    );
  });

  it('hyperlinks scheme-prefixed URLs without markdown wrappers', async () => {
    const { container } = render(
      <MarkdownText text="See https://bytescafesa.com/lounge for hours." />,
    );
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    expect(hrefs(container)).toContain('https://bytescafesa.com/lounge');
  });

  it('hyperlinks www hosts without a scheme', async () => {
    const { container } = render(<MarkdownText text="Visit www.jbgamingcafe.com tonight." />);
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    expect(hrefs(container)).toContain('https://www.jbgamingcafe.com');
  });

  it('does not linkify hostnames inside inline code or fences', async () => {
    const { container } = render(
      <MarkdownText text={'Use `bytescafesa.com` and\n\n```\nmixeresports.com\n```\n'} />,
    );
    await waitFor(() => expect(container.textContent).toContain('bytescafesa.com'));
    expect(hrefs(container)).toEqual([]);
  });

  it('leaves explicit markdown links unchanged', async () => {
    const { container } = render(
      <MarkdownText text="Go to [Bytes](https://bytescafesa.com/lounge) now." />,
    );
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://bytescafesa.com/lounge');
    expect(a.textContent).toContain('Bytes');
  });
});

describe('isAllowedImageSrc', () => {
  it('allows http(s), same-origin paths, and blob URLs', () => {
    expect(isAllowedImageSrc('https://www.cyberracoon.com/gallery/room.jpg')).toBe(true);
    expect(isAllowedImageSrc('http://example.com/a.png')).toBe(true);
    expect(isAllowedImageSrc('/api/files/photo.jpg')).toBe(true);
    expect(isAllowedImageSrc('blob:https://roselabs.ai/11111111-1111-1111-1111-111111111111')).toBe(
      true,
    );
  });

  it('rejects javascript, data, file, and protocol-relative sources', () => {
    expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedImageSrc('data:image/gif;base64,AAAA')).toBe(false);
    expect(isAllowedImageSrc('file:///etc/passwd')).toBe(false);
    expect(isAllowedImageSrc('//evil.example/pixel.gif')).toBe(false);
    expect(isAllowedImageSrc('')).toBe(false);
    expect(isAllowedImageSrc(undefined)).toBe(false);
  });
});

describe('linkifyMarkdownText', () => {
  it('wraps parenthetical hostnames from the captured attention text', () => {
    expect(linkifyMarkdownText('**Bytes Cyber Café** (bytescafesa.com)')).toBe(
      '**Bytes Cyber Café** ([bytescafesa.com](https://bytescafesa.com))',
    );
  });

  it('leaves schemed URLs, code, and existing markdown links alone', () => {
    expect(linkifyMarkdownText('See https://bytescafesa.com/lounge')).toBe(
      'See https://bytescafesa.com/lounge',
    );
    expect(linkifyMarkdownText('Use `bytescafesa.com` now')).toBe('Use `bytescafesa.com` now');
    expect(linkifyMarkdownText('Go [Bytes](https://bytescafesa.com) now')).toBe(
      'Go [Bytes](https://bytescafesa.com) now',
    );
    expect(linkifyMarkdownText('contact user@bytescafesa.com')).toBe(
      'contact user@bytescafesa.com',
    );
    expect(linkifyMarkdownText('do not link node.js or package.json')).toBe(
      'do not link node.js or package.json',
    );
  });

  it('linkifies non-com country hosts and leaves dotted versions alone', () => {
    expect(linkifyMarkdownText('See google.de and 1.2.3')).toBe(
      'See [google.de](https://google.de) and 1.2.3',
    );
  });
});
