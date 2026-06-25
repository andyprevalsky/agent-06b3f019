/**
 * Inner form for the launcher pill — input + submit button.
 *
 * Thin view: receives state + handlers from `useLauncher` via props and
 * renders the controlled `<input>` + submit `<LiquidWhiteButton>`. No IO,
 * no business logic, no IPC.
 */

import type { CSSProperties, FormEvent, KeyboardEvent, RefObject } from 'react';
import { ArrowUp } from 'lucide-react';

interface QueryFormProps {
  query: string;
  setQuery: (value: string) => void;
  submitting: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  handleSubmit: (event?: FormEvent) => Promise<void>;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  fontSize: 13,
  color: '#272725',
  border: 'none',
  outline: 'none',
};

const FORM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '100%',
  gap: 12,
  paddingLeft: 16,
  paddingRight: 4,
};

const SUBMIT_BUTTON_STYLE: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: '50%',
  border: '1px solid rgba(255, 255, 255, 0.85)',
  background: 'linear-gradient(180deg, #f4f4f4 0%, #cfcfcf 45%, #9f9f9f 100%)',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), inset 0 1px 2px rgba(255, 255, 255, 0.8)',
  color: '#ffffff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
};

const QueryForm = ({
  query,
  setQuery,
  submitting,
  inputRef,
  handleSubmit,
  handleKeyDown,
}: QueryFormProps): React.JSX.Element => {
  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      style={FORM_STYLE}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        placeholder="Enter any desire"
        className="placeholder-input"
        style={INPUT_STYLE}
      />

      <button
        type="button"
        data-testid="submit-button"
        onClick={() => {
          void handleSubmit();
        }}
        disabled={submitting}
        style={{
          ...SUBMIT_BUTTON_STYLE,
          opacity: submitting ? 0.5 : 1,
          cursor: submitting ? 'not-allowed' : 'pointer',
        }}
      >
        <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
      </button>
    </form>
  );
};

export default QueryForm;
