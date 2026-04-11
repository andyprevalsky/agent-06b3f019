/**
 * STATE MACHINE: IntegrationModals
 *
 * [MOUNTED] --> renders modal overlays based on open/close state from hooks.
 */

import AtlasPasswordModal from '@/components/AtlasPasswordModal';
import ApplePasswordsModal from '@/components/ApplePasswordsModal';

import type { useBrowserSync } from '../hooks/useBrowserSync';
import type { usePasswordSync } from '../hooks/usePasswordSync';
import type { useIntegrationActions } from '../hooks/useIntegrationActions';

interface IntegrationModalsProps {
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  actions: ReturnType<typeof useIntegrationActions>;
}

export default function IntegrationModals({ browser, passwords, actions }: IntegrationModalsProps) {
  return (
    <>
      {/* Atlas Browser Data Modal */}
      <AtlasPasswordModal
        isOpen={browser.atlasModalOpen}
        onClose={browser.closeAtlasModal}
        onSync={browser.handleAtlasSync}
        onOpenKeychain={browser.handleOpenKeychain}
        syncType="browser data"
      />

      {/* Apple Passwords Modal */}
      <ApplePasswordsModal
        isOpen={passwords.applePasswordsModalOpen}
        onClose={() => passwords.setApplePasswordsModalOpen(false)}
        onSync={actions.onApplePasswordsSync}
      />

      {/* Atlas Passwords Modal */}
      <AtlasPasswordModal
        isOpen={passwords.atlasPasswordsModalOpen}
        onClose={() => passwords.setAtlasPasswordsModalOpen(false)}
        onSync={actions.onAtlasPasswordsSync}
        onOpenKeychain={browser.handleOpenKeychain}
        syncType="passwords"
      />
    </>
  );
}
