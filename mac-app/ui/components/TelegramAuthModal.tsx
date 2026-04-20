/**
 * Shim — the TelegramAuthModal feature lives at
 * `ui/features/telegram-auth-modal/`.
 *
 * This re-export is retained because existing blackbox tests reference this
 * path directly (`import TelegramAuthModal from '../../ui/components/TelegramAuthModal'`).
 * Once those tests move to the new path this file can be deleted.
 */
export { default, default as TelegramAuthModal } from '../features/telegram-auth-modal';
