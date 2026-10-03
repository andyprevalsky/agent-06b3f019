import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StructuredResponseDisplay } from '@/features/terminal-component-group/components/StructuredResponseDisplay';

describe('StructuredResponseDisplay', () => {
  it('shows every property of object array outputs without coercing objects to strings', () => {
    render(
      <StructuredResponseDisplay
        structuredResponse={{
          items: [
            { name: 'Desk lamp', price: 28 },
            { name: 'Bookshelf', price: 75 },
          ],
        }}
        outputSchema={{
          fields: [{ name: 'items', type: 'list[object]', required: true, description: '' }],
        }}
      />,
    );

    expect(screen.getByText('Items')).toBeInTheDocument();
    expect(screen.getByText(/Desk lamp/)).toBeInTheDocument();
    expect(screen.getByText(/Bookshelf/)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('shows a file output as an openable file chip', () => {
    render(
      <StructuredResponseDisplay
        structuredResponse={{
          inventory_file: {
            id: 'file-1',
            storage_path: 'outputs/inventory.csv',
            original_filename: 'inventory.csv',
            mime_type: 'text/csv',
            size_bytes: 128,
            created_at: '2026-09-29T00:00:00Z',
          },
        }}
        outputSchema={{
          fields: [{ name: 'inventory_file', type: 'file_pointer', required: true }],
        }}
      />,
    );

    expect(screen.getByTestId('file-pointer-chip')).toHaveAttribute(
      'data-filename',
      'inventory.csv',
    );
  });

  it('keeps primitive arrays readable as comma-separated values', () => {
    render(
      <StructuredResponseDisplay
        structuredResponse={{ tags: ['alpha', 'beta'] }}
        outputSchema={{
          fields: [{ name: 'tags', type: 'list[str]', required: true }],
        }}
      />,
    );

    expect(screen.getByText('alpha, beta')).toBeInTheDocument();
  });
});
