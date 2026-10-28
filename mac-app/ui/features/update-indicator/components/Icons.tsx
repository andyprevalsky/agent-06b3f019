/**
 * Inline SVG icons used by UpdateIndicator chips. Isolated here so the
 * main component stays under the strict per-function line limit.
 */

export const GiftIcon = (): React.ReactElement => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600 dark:text-[#e4e4df]"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 3.5c1.5-1.5 4-1.5 5 0s1 3.5-1 5h4v3H4v-3h4c-2-1.5-2-4-1-5s3.5-1.5 5 0zM5 11.5v9h14v-9M12 8.5v12"
    />
  </svg>
);

export const CheckIcon = (): React.ReactElement => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600 dark:text-[#e4e4df]"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2.5}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

export const WarningIcon = (): React.ReactElement => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600 dark:text-[#e4e4df]"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);
