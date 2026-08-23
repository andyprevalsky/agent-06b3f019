import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf8');
}

describe('top-right account control ownership', () => {
  it('keeps inspection and admin account controls in the AppShell-owned rail', () => {
    const appShell = source('features/app-wiring/components/AppShell.tsx');
    const inspectionBadge = source('features/terminal/components/InspectionAccountBadge.tsx');
    const adminSwitcher = source(
      'features/admin-account-switcher/components/AdminAccountSwitcher.tsx',
    );

    expect(appShell).toMatch(
      /<TopRightControls>\s*<AdminSwitcherMount\s*\/>\s*<\/TopRightControls>/,
    );
    expect(inspectionBadge).toContain('createPortal(');
    expect(inspectionBadge).toContain('TOP_RIGHT_INSPECTION_SLOT_ID');
    expect(inspectionBadge).not.toMatch(/className="[^"]*\bfixed\b/);
    expect(adminSwitcher).not.toMatch(/className="[^"]*\bfixed\b/);
  });
});
