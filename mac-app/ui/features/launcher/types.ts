/**
 * Type definitions for the launcher feature — the floating Quick-Query
 * window that overlays on top of the user's desktop.
 *
 * Types layer: external packages + shared provider types only. No imports
 * from own api/hooks/components.
 */

/**
 * Props for the shader backdrop tile. `size` is the pixel height of the
 * pill-shaped launcher so the shader can fill its container exactly.
 */
export interface ShaderTileProps {
  size: number;
}
