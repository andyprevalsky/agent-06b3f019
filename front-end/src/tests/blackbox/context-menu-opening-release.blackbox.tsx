/**
 * Blackbox: releasing the mouse press that opened a context menu never picks an item.
 *
 * Radix positions a context menu's first frame against its previous anchor (the
 * viewport origin on a first open) before it moves to the pointer, and a menu
 * item selects itself on any pointerup it did not see go down. A quick
 * right-click on a sidebar project row therefore released over "Delete project"
 * at the top-left and opened the delete confirmation (semantic
 * projects-sidebar-flow at 1280px). A press-drag-release that ends on an item
 * away from the press point still selects it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

function renderMenu(onDelete: () => void) {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="row">Rose</ContextMenuTrigger>
      <ContextMenuContent data-testid="menu">
        <ContextMenuItem onSelect={() => {}}>Rename project</ContextMenuItem>
        <ContextMenuItem onSelect={onDelete}>Delete project</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
}

describe('Context menu opened by a mouse press', () => {
  it('ignores the release of that same press, even over an item', async () => {
    const onDelete = vi.fn();
    renderMenu(onDelete);
    const press = { pointerType: 'mouse', button: 2, clientX: 117, clientY: 107 };
    fireEvent.pointerDown(screen.getByTestId('row'), press);
    fireEvent.contextMenu(screen.getByTestId('row'), press);
    const item = await screen.findByRole('menuitem', { name: 'Delete project' });
    fireEvent.pointerUp(item, press);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
  });

  it('still selects an item the pointer is dragged to and released on', async () => {
    const onDelete = vi.fn();
    renderMenu(onDelete);
    const press = { pointerType: 'mouse', button: 2, clientX: 117, clientY: 107 };
    fireEvent.pointerDown(screen.getByTestId('row'), press);
    fireEvent.contextMenu(screen.getByTestId('row'), press);
    const item = await screen.findByRole('menuitem', { name: 'Delete project' });
    fireEvent.pointerUp(item, { ...press, clientX: 160, clientY: 200 });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('selects on a later click at the press point once the opening press was released', async () => {
    const onDelete = vi.fn();
    renderMenu(onDelete);
    const press = { pointerType: 'mouse', button: 2, clientX: 117, clientY: 107 };
    fireEvent.contextMenu(screen.getByTestId('row'), press);
    fireEvent.pointerUp(document.body, press);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = await screen.findByRole('menuitem', { name: 'Delete project' });
    fireEvent.pointerUp(item, { ...press, button: 0 });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
