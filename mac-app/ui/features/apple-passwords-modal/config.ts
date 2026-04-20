/**
 * Config for the apple-passwords-modal feature: constants used to validate
 * file selections and position the screenshot highlight overlay.
 */

export const ACCEPTED_EXTENSION = '.csv';

// Shown both when the user picks a non-CSV file and when they click Import
// without any file selected — the surface message is identical in both cases.
export const CSV_REQUIRED_MESSAGE = 'Please select a CSV file';
export const GENERIC_IMPORT_FAILURE = 'Failed to import passwords';

/**
 * Position of the red highlight box over "Export All Passwords to File..."
 * in the screenshot. Percentages relative to the image dimensions so the
 * overlay tracks the image in both thumbnail and lightbox views.
 */
export const EXPORT_HIGHLIGHT_STYLE: React.CSSProperties = {
  top: '69%',
  left: '34%',
  width: '55%',
  height: '10%',
};
