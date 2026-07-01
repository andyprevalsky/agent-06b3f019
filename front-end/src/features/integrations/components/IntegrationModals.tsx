/**
 * STATE MACHINE: IntegrationModals
 *
 * [MOUNTED] --> renders modal overlays based on open/close state from hooks.
 */

import AtlasPasswordModal from '@/components/AtlasPasswordModal';
import PasskeysModal from '@/components/PasskeysModal';

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

      {/* Apple Passwords & Passkeys Modal */}
      <PasskeysModal
        isOpen={passwords.passkeysModalOpen}
        onClose={() => passwords.setPasskeysModalOpen(false)}
        onSync={actions.onPasskeysConnect}
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
