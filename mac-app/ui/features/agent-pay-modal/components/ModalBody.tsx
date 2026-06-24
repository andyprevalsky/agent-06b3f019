/**
 * STATE MACHINE: AgentPayModal Body
 *
 * [LOADING] -- settings loaded --> [EDITING_LIMIT_AND_ADDRESS]
 * [EDITING_LIMIT_AND_ADDRESS] -- validation error --> [EDITING_WITH_ERRORS]
 * [EDITING_LIMIT_AND_ADDRESS] -- save clicked --> [SAVING]
 * [SAVING] -- failure --> [EDITING_WITH_ERRORS]
 * [SAVING] -- success/close --> [CLOSED]
 *
 * Card-entry states are intentionally absent. The modal now persists only an
 * autopay limit plus delivery address data; checkout cards are minted later.
 */

import type { UseAgentPayModalResult } from '../types';
import { DeliveryAddressForm } from './DeliveryAddressForm';
import { SecurityNotice } from './SecurityNotice';

/**
 * The scrollable body region of the modal — security notice, autopay limit,
 * delivery-address block, and any save-error banner.
 */
export const ModalBody = ({ modal }: { modal: UseAgentPayModalResult }) => (
  <>
    <SecurityNotice />

    <div className="space-y-2">
      <label htmlFor="agent-pay-autopay-limit" className="block text-sm font-medium">
        Autopay limit ($)
      </label>
      <input
        id="agent-pay-autopay-limit"
        type="number"
        min="0"
        step="0.01"
        value={modal.autopayLimitDisplay}
        onChange={(event) => modal.setAutopayLimitDisplay(event.target.value)}
        onBlur={modal.handleAutopayBlur}
        disabled={modal.saving}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      {modal.paymentErrors.autoagentpaylimit_cents !== undefined && (
        <p className="text-sm text-red-500">{modal.paymentErrors.autoagentpaylimit_cents}</p>
      )}
    </div>

    <DeliveryAddressForm
      shippingAddress={modal.shippingAddress}
      paymentErrors={modal.paymentErrors}
      sameAsBilling={modal.sameAsBilling}
      showCardForm={modal.showCardForm}
      saving={modal.saving}
      setSameAsBilling={modal.setSameAsBilling}
      setShippingField={modal.setShippingField}
    />

    {modal.error !== null && <p className="text-sm text-red-500">{modal.error}</p>}
  </>
);
