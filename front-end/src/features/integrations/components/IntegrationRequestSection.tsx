/**
 * STATE MACHINE: IntegrationRequestSection (Rose Desktop; data in useIntegrationRequest)
 *
 * The last section, "Other": one ordinary integration row.
 *   [CLOSED]  tile · "An integration not listed here?" · pink "Request"
 *   [CLOSED] --Request--> [FORM OPEN] input "Integration you want" · Send · Cancel
 *   [FORM OPEN] --Send--> [SENDING] (inputs disabled)
 *     --ok--> [SENT] "Thanks! We'll add <X> within 2 business days." · "Request another"
 *     --refused--> [FORM OPEN] + error line, draft kept (a retry reuses its request id)
 * The backend texts the Rose team "<user> wants a new integration: <X>".
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';

import { integrationMatchesSearch } from '../hooks/integrationSearch';
import { useIntegrationRequest } from '../hooks/useIntegrationRequest';
import DesktopIntegrationRow, {
  ACTION_CLASSES,
  type DesktopIntegrationView,
} from './DesktopIntegrationRow';
import { DropdownIconPreset } from './DropdownIconFrame';
import { RowForm, ToolGlyph, ToolSection } from './DesktopToolSections';
import { TOOL_ROW_INPUT_CLASSES } from './integrationCardStyles';

export default function IntegrationRequestSection({ search }: { search: string }) {
  const request = useIntegrationRequest();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const submit = async () => {
    if (await request.submit(draft)) {
      setOpen(false);
      setDraft('');
    }
  };
  const view: DesktopIntegrationView = {
    key: 'integration-request',
    name: 'An integration not listed here?',
    icon: {
      preset: DropdownIconPreset.cli,
      glyph: (
        <ToolGlyph>
          <Plus className="h-[85%] w-[85%]" />
        </ToolGlyph>
      ),
    },
    accounts: [],
    availability: 'ready',
    connectLabel: 'Request',
    extra: (
      <>
        {!open && request.sent === null && (
          <p className="ml-[46px] mt-1 text-xs text-muted-foreground">
            Tell us what to connect and we&apos;ll add it within 2 business days.
          </p>
        )}
        {open && (
          <RowForm
            label="Send integration request"
            busy={request.sending}
            error={request.error}
            onSubmit={() => void submit()}
            onCancel={() => setOpen(false)}
          >
            <input
              aria-label="Integration you want"
              placeholder="e.g. Linear, Notion, your company's CRM"
              value={draft}
              maxLength={200}
              autoFocus
              onChange={(event) => {
                setDraft(event.target.value);
                request.draftChanged();
              }}
              className={`${TOOL_ROW_INPUT_CLASSES} flex-1`}
            />
          </RowForm>
        )}
        {request.sent !== null && !open && (
          <p role="status" className="ml-[46px] mt-1 text-xs text-muted-foreground">
            Thanks! We&apos;ll add {request.sent} within 2 business days.{' '}
            <button
              type="button"
              className={ACTION_CLASSES}
              onClick={() => {
                request.reset();
                setOpen(true);
              }}
            >
              Request another
            </button>
          </p>
        )}
      </>
    ),
  };
  if (!open && request.sent === null) view.onConnect = () => setOpen(true);
  return (
    <ToolSection title="Other" hidden={!integrationMatchesSearch('other', search)}>
      <DesktopIntegrationRow view={view} />
    </ToolSection>
  );
}
