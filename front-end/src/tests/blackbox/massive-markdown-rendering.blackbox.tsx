import { act, render } from '@testing-library/react';
import { Suspense, startTransition, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';

const callbacks = vi.hoisted(() => [] as Array<() => void>);
vi.mock(
  '@/features/terminal-component-group/components/markdown-text/fadeWords',
  async (original) => {
    const source =
      await original<
        typeof import('@/features/terminal-component-group/components/markdown-text/fadeWords')
      >();
    return {
      ...source,
      createFadeWordSpan: (onLastWordComplete: () => void) => {
        callbacks.push(onLastWordComplete);
        return source.createFadeWordSpan(onLastWordComplete);
      },
    };
  },
);
beforeEach(() => {
  callbacks.length = 0;
});

describe('large markdown output', () => {
  it('keeps committed animation completion valid after a suspended replacement render is discarded', () => {
    const onComplete = vi.fn();
    let update: (value: string) => void = () => {};
    const pending = new Promise<void>(() => {});
    function SuspendReplacement({ text }: { text: string }) {
      if (text === 'Replacement output') throw pending;
      return null;
    }
    function Harness() {
      const [text, setText] = useState('Committed output');
      update = setText;
      return (
        <Suspense fallback={<p>Waiting</p>}>
          <MarkdownText text={text} shouldAnimate onComplete={onComplete} />
          <SuspendReplacement text={text} />
        </Suspense>
      );
    }
    const { container, unmount } = render(<Harness />);
    const committedComplete = callbacks.at(-1)!;
    act(() => startTransition(() => update('Replacement output')));
    expect(container.querySelector('p')).toHaveTextContent('Committed output');
    expect(container.textContent).not.toContain('Waiting');
    committedComplete();
    expect(onComplete).toHaveBeenCalledOnce();
    unmount();
  });

  it('retires animation completion when its owner unmounts', () => {
    const onComplete = vi.fn();
    const { unmount } = render(
      <MarkdownText text="Retired output" shouldAnimate onComplete={onComplete} />,
    );
    const complete = callbacks.at(-1)!;
    unmount();
    complete();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('preserves a 2MB fenced tool output as one code block with all content', () => {
    const code = 'const value = "example.com output";\n'.repeat(60_000);
    const { container, unmount } = render(<MarkdownText text={`\`\`\`js\n${code}\`\`\``} />);
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(container.querySelectorAll('code')).toHaveLength(1);
    expect(container.querySelector('code')?.textContent).toBe(code);
    expect(container.querySelector('a')).toBeNull();
    unmount();
  });

  it('renders changed animated output instead of retaining the previous extracted tree', () => {
    const oldOutput = 'Previous output with **bold**';
    const newCode = 'updated value\n'.repeat(2_000);
    const newOutput = `# Updated output\n\n\`\`\`\n${newCode}\`\`\``;
    const { container, rerender, unmount } = render(
      <MarkdownText text={oldOutput} shouldAnimate />,
    );
    expect(container.querySelector('p')?.textContent).toBe('Previous output with bold');
    rerender(<MarkdownText text={newOutput} shouldAnimate />);
    expect(container.querySelector('h1')).toHaveTextContent('Updated output');
    expect(container.querySelector('pre')?.textContent).toBe(newCode);
    expect(container.textContent).not.toContain('Previous output');
    unmount();
  });

  it('rejects retired completion callbacks after animated output A -> B -> A', () => {
    const onComplete = vi.fn();
    const { container, rerender, unmount } = render(
      <MarkdownText text="First output" shouldAnimate onComplete={onComplete} />,
    );
    const firstComplete = callbacks.at(-1)!;
    rerender(<MarkdownText text="Second output" shouldAnimate onComplete={onComplete} />);
    const secondComplete = callbacks.at(-1)!;
    rerender(<MarkdownText text="First output" shouldAnimate onComplete={onComplete} />);
    const currentComplete = callbacks.at(-1)!;
    expect(container.querySelector('p')?.textContent).toBe('First output');
    firstComplete();
    secondComplete();
    expect(onComplete).not.toHaveBeenCalled();
    currentComplete();
    expect(onComplete).toHaveBeenCalledTimes(1);
    unmount();
  });
});
