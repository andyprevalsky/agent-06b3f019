/**
 * Renderer entry compatibility shim. The electron-app shell now lives in
 * `ui/features/electron-app/` (layered architecture). This file re-exports
 * the default so existing test files that import `../../ui/ElectronApp`
 * continue to resolve without change.
 */

export { default } from './features/electron-app';
