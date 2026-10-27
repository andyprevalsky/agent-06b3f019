/**
 * Recharts tooltip box on the theme's popover tokens (light and Rose dark).
 * Recharts colours each row with its series stroke; neutral series stroke
 * `currentColor` (the page foreground), which a fixed white box made
 * unreadable on dark. Rows and label use the popover foreground instead.
 * Spread onto <Tooltip> (a wrapper component would hide it from Recharts).
 */
export const THEMED_TOOLTIP = {
  contentStyle: {
    backgroundColor: 'hsl(var(--popover))',
    borderColor: 'hsl(var(--border))',
    color: 'hsl(var(--popover-foreground))',
  },
  itemStyle: { color: 'hsl(var(--popover-foreground))' },
  labelStyle: { color: 'hsl(var(--popover-foreground))' },
} as const;
