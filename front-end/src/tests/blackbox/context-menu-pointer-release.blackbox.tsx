import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

async function open(onSelect = vi.fn(), onPointerUp?: React.PointerEventHandler<HTMLDivElement>) {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="trigger">Project</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect} onPointerUp={onPointerUp}>
          Delete project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 117, clientY: 107 });
  return { item: await screen.findByRole('menuitem', { name: 'Delete project' }), onSelect };
}
function release(item: HTMLElement, button: number) {
  fireEvent.pointerUp(item, { pointerType: 'mouse', button, clientX: 117, clientY: 107 });
}
describe('context menu pointer release ownership', () => {
  it.each([1, 2])('does not select an item from the opening mouse button %i release', async (button) => {
    const { item, onSelect } = await open();
    release(item, button);
    expect(onSelect).not.toHaveBeenCalled();
    expect(item).toBeVisible();
  });
  it('keeps primary release selection', async () => {
    const { item, onSelect } = await open();
    fireEvent.pointerUp(document.body, { pointerType: 'mouse', button: 2, clientX: 117, clientY: 107 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(item, 0);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it('keeps keyboard selection', async () => {
    const { item, onSelect } = await open();
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it('preserves the caller cancellation of primary release', async () => {
    const cancel = vi.fn((event: React.PointerEvent<HTMLDivElement>) => event.preventDefault());
    const { item, onSelect } = await open(vi.fn(), cancel);
    fireEvent.pointerUp(document.body, { pointerType: 'mouse', button: 2, clientX: 117, clientY: 107 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(item, 0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(item).toBeVisible();
  });
});
