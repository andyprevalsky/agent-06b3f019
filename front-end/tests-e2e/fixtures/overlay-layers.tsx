import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogContent, DialogTitle } from '../../src/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../../src/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '../../src/components/ui/popover';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../../src/components/ui/context-menu';
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from '../../src/components/ui/sheet';
import '../../src/index.css';
export function App() {
  const [value, setValue] = useState('first');
  const [result, setResult] = useState('none');
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#fbb' }}
        aria-hidden="true"
      />
      <Dialog open>
        <DialogContent style={{ width: 520, height: 430 }}>
          <DialogTitle>Layer proof</DialogTitle>
          <div style={{ display: 'grid', gap: 20 }}>
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger aria-label="Select a choice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first">First choice</SelectItem>
                <SelectItem value="second">Second choice</SelectItem>
              </SelectContent>
            </Select>
            <output data-testid="value">{value}</output>
            <Popover>
              <PopoverTrigger>Open popover</PopoverTrigger>
              <PopoverContent side="top">
                <button onClick={() => setResult('popover')}>Popover action</button>
              </PopoverContent>
            </Popover>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div style={{ padding: 20, border: '1px solid' }} id="context">
                  Right click here
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setResult('context')}>
                  Context action
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <Sheet>
              <SheetTrigger>Open sheet</SheetTrigger>
              <SheetContent style={{ width: '100%', height: '100%' }}>
                <SheetTitle>Nested sheet</SheetTitle>
                <button
                  style={{ position: 'absolute', left: '45%', top: '45%' }}
                  onClick={() => setResult('sheet')}
                >
                  Sheet action
                </button>
              </SheetContent>
            </Sheet>
            <output data-testid="result">{result}</output>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
