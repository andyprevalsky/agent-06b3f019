import type { UseAgentPayModalResult } from '../types';
import { CardForm } from './CardForm';
import { DeliveryAddressForm } from './DeliveryAddressForm';
import { SavedCardSummary } from './SavedCardSummary';
import { SecurityNotice } from './SecurityNotice';

/**
 * The scrollable body region of the modal — security notice, saved-card
 * summary (or card form), delivery-address block, and any save-error
 * banner. Factored out so `AgentPayModal` stays under the 80-line strict
 * function cap.
 */
export const ModalBody = ({ modal }: { modal: UseAgentPayModalResult }) => (
  <>
    <SecurityNotice />

    {modal.savedEnvelope !== null && !modal.editingCard && (
      <SavedCardSummary envelope={modal.savedEnvelope} onEdit={() => modal.setEditingCard(true)} />
    )}

    {modal.showCardForm && (
      <CardForm
        paymentData={modal.paymentData}
        paymentErrors={modal.paymentErrors}
        autopayLimitDisplay={modal.autopayLimitDisplay}
        saving={modal.saving}
        setAutopayLimitDisplay={modal.setAutopayLimitDisplay}
        handleAutopayBlur={modal.handleAutopayBlur}
        handleCardNumber={modal.handleCardNumber}
        handleExpiry={modal.handleExpiry}
        handleCVV={modal.handleCVV}
        setPaymentField={modal.setPaymentField}
      />
    )}

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
