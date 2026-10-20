/**
 * Rose dark mode stylesheet contracts (split from rose-theme.blackbox.tsx):
 * every html.dark scrollbar / color-scheme rule and the neutral mock palette
 * for the theme tokens, parsed from index.css. Light mode is untouched: the
 * :root palette is asserted unchanged and every dark rule is html.dark-scoped.
 */
import fs from 'node:fs';
import path from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

describe('dark scrollbars (row 62)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf-8');
  const root = postcss.parse(css);
  const scrollbarRules: Rule[] = [];
  root.walkRules((rule) => {
    const touchesScrollbars =
      rule.selector.includes('::-webkit-scrollbar') ||
      rule.some(
        (node) =>
          node.type === 'decl' && (node.prop === 'color-scheme' || node.prop === 'scrollbar-color'),
      );
    // The code-agent terminal keeps its own green scrollbar in both themes.
    if (touchesScrollbars && !rule.selector.includes('.code-agent-terminal-host')) {
      scrollbarRules.push(rule);
    }
  });

  function decls(selector: string): Record<string, string> {
    const rule = scrollbarRules.find((r) => r.selectors.includes(selector));
    if (rule === undefined) throw new Error(`missing rule ${selector}`);
    const out: Record<string, string> = {};
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
    return out;
  }

  it('scopes every scrollbar / color-scheme rule under html.dark (light untouched)', () => {
    expect(scrollbarRules.length).toBeGreaterThanOrEqual(6);
    for (const rule of scrollbarRules) {
      for (const selector of rule.selectors) {
        expect(selector).toMatch(/^html\.dark(\s|$)/);
      }
    }
  });

  it('uses dark native controls and the navi scrollbar colours', () => {
    expect(decls('html.dark')['color-scheme']).toBe('dark');
    expect(decls('html.dark *')['scrollbar-color']).toBe('#4a4a46 transparent');
    expect(decls('html.dark ::-webkit-scrollbar-thumb')).toMatchObject({
      background: '#4a4a46',
      'border-radius': '10px',
      border: '2px solid #272725',
    });
    expect(decls('html.dark ::-webkit-scrollbar-thumb:hover').background).toBe('#5c5c57');
    expect(decls('html.dark ::-webkit-scrollbar-track').background).toBe('transparent');
    expect(decls('html.dark ::-webkit-scrollbar-corner').background).toBe('transparent');
    expect(decls('html.dark ::-webkit-scrollbar').background).toBe('transparent');
  });

  it('keeps the webkit hover thumb in Chromium: scrollbar-color only where ::-webkit-scrollbar is unsupported', () => {
    // Chromium ignores every ::-webkit-scrollbar rule on an element with a
    // non-auto scrollbar-color, which would drop the #5c5c57 hover thumb.
    const colorRules = scrollbarRules.filter((rule) =>
      rule.some((node) => node.type === 'decl' && node.prop === 'scrollbar-color'),
    );
    expect(colorRules.length).toBeGreaterThan(0);
    for (const rule of colorRules) {
      const parent = rule.parent;
      expect(parent?.type).toBe('atrule');
      expect(parent?.type === 'atrule' && `@${parent.name} ${parent.params}`).toBe(
        '@supports not selector(::-webkit-scrollbar)',
      );
    }
  });

  it('paints the page solid navi black, scoped to html.dark', () => {
    const pageRules: Rule[] = [];
    root.walkRules((rule) => {
      if (rule.selectors.includes('html.dark body')) pageRules.push(rule);
    });
    expect(pageRules).toHaveLength(1);
    const [page] = pageRules;
    page.selectors.forEach((selector) => expect(selector).toMatch(/^html\.dark(\s|$)/));
    const background: string[] = [];
    page.walkDecls('background-color', (d) => {
      background.push(d.value);
    });
    expect(background).toEqual(['#272725']);
  });
});

describe('dark palette tokens (mock panels/dark.js; no navy surfaces)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf-8');
  const root = postcss.parse(css);
  const TOKENS = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'border',
    'input',
    'ring',
  ].map((t) => `--${t}`);

  function tokensOf(selector: string): Record<string, string>[] {
    const found: Record<string, string>[] = [];
    root.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      const out: Record<string, string> = {};
      rule.walkDecls((d) => {
        if (TOKENS.includes(d.prop)) out[d.prop] = d.value;
      });
      if (Object.keys(out).length > 0) found.push(out);
    });
    return found;
  }

  /** Each token is `H S% L%`; the mock's greys are hue 60 at <= 11% saturation. */
  function hsl(value: string) {
    const [h, s, l] = value.split(/\s+/).map((part) => parseFloat(part));
    return { h, s, l };
  }

  it('html.dark sets every surface/text token to the neutral mock palette', () => {
    const rules = tokensOf('html.dark');
    expect(rules).toHaveLength(1);
    const [dark] = rules;
    expect(Object.keys(dark).sort()).toEqual([...TOKENS].sort());
    for (const token of TOKENS) {
      const { h, s } = hsl(dark[token]!);
      expect({ token, h }).toEqual({ token, h: 60 });
      expect(s).toBeLessThanOrEqual(11);
    }
    // Exact anchors: page #272725, popover/menu #2f2f2c, muted text #a3a39d,
    // primary inverted like New Super Agent (#f2f2ef on #1f1f1d).
    expect(dark['--background']).toBe('60 2.6% 14.9%');
    expect(dark['--popover']).toBe('60 3.3% 17.8%');
    expect(dark['--secondary']).toBe('60 3.3% 17.8%');
    expect(dark['--muted-foreground']).toBe('60 3.2% 62.7%');
    expect(dark['--primary']).toBe('60 10.3% 94.3%');
    expect(dark['--primary-foreground']).toBe('60 3.3% 11.8%');
  });

  it('every rule that touches these tokens outside :root is html.dark or the stock .dark', () => {
    const selectors: string[] = [];
    root.walkRules((rule) => {
      if (rule.some((node) => node.type === 'decl' && TOKENS.includes(node.prop))) {
        selectors.push(...rule.selectors);
      }
    });
    expect(new Set(selectors)).toEqual(new Set([':root', '.dark', 'html.dark']));
  });

  it('light control: the :root palette is unchanged', () => {
    const light = Object.assign({}, ...tokensOf(':root')) as Record<string, string>;
    expect(light).toMatchObject({
      '--background': '240 15% 98%',
      '--foreground': '240 15% 8%',
      '--primary': '240 15% 8%',
      '--card': '0 0% 100%',
      '--secondary': '240 10% 96%',
      '--muted': '240 8% 92%',
      '--muted-foreground': '240 8% 45%',
      '--border': '240 8% 88%',
      '--input': '240 8% 94%',
    });
  });
});

describe('Rose Settings drawer dark stylesheet (mock .acp: flat rows, text tabs)', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../../features/settings/components/roseSettings.css'),
    'utf-8',
  );
  const root = postcss.parse(css);
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    rules.push(rule);
  });

  function decls(selector: string): Record<string, string> {
    const rule = rules.find((r) => r.selectors.includes(selector));
    if (rule === undefined) throw new Error(`missing rule ${selector}`);
    const out: Record<string, string> = {};
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
    return out;
  }

  it('scopes every rule to html.dark .rose-settings (light and the stock page untouched)', () => {
    expect(rules.length).toBeGreaterThanOrEqual(6);
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        expect(selector).toMatch(/^html\.dark \.rose-settings /);
      }
    }
  });

  it('replaces the segmented tabs with text tabs and a rose underline on the active tab', () => {
    expect(decls("html.dark .rose-settings [role='tablist']")).toMatchObject({
      background: 'transparent',
      padding: '0',
      'border-radius': '0',
      'border-bottom': '1px solid rgba(255, 255, 255, 0.08)',
    });
    expect(decls("html.dark .rose-settings [role='tab']")).toMatchObject({
      background: 'transparent',
      'box-shadow': 'none',
      color: '#a3a39d',
    });
    expect(decls("html.dark .rose-settings [role='tab'][data-state='active']")).toMatchObject({
      color: '#f2f2ef',
      'font-weight': '600',
      'box-shadow': 'inset 0 -2px 0 #e8507f',
    });
  });

  it('flattens the cards and puts fields on the #2f2f2c control surface', () => {
    expect(decls('html.dark .rose-settings .bg-card')).toMatchObject({
      background: 'transparent',
      'border-color': 'transparent',
      'box-shadow': 'none',
    });
    expect(decls('html.dark .rose-settings textarea')).toMatchObject({
      'background-color': '#2f2f2c',
      'border-color': 'rgba(255, 255, 255, 0.12)',
      color: '#f2f2ef',
    });
  });

  it('uses no navy colours', () => {
    expect(css.toLowerCase()).not.toMatch(/#0f172a|#020817|#1e293b|#111827|#1f2937|hsl\(22\d/);
  });
});
