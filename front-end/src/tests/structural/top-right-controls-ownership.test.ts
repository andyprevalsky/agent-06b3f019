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

  it('keeps the rail clear of the Rose Desktop top-right app icons on md+', () => {
    // Regression: at 1440x900 the account pill covered the Browser globe and
    // the drawer close X (2026-10-20 recording). Since UI ledger row 66 the
    // icons sit bare in the top-right corner and publish their own width.
    const rail = source('components/TopRightControls.tsx');
    expect(rail).toContain('md:right-[calc(var(--rose-app-icons-inset,0px)+1rem)]');
  });
});
