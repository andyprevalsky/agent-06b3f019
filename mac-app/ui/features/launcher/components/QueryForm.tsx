/**
 * Inner form for the launcher pill — input + submit button.
 *
 * Thin view: receives state + handlers from `useLauncher` via props and
 * renders the controlled `<input>` + submit `<LiquidWhiteButton>`. No IO,
 * no business logic, no IPC.
 */

import type { CSSProperties, FormEvent, KeyboardEvent, RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';

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

      <LiquidWhiteButton
        onClick={() => {
          void handleSubmit();
        }}
        disabled={submitting}
        size="sm"
      >
        <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
      </LiquidWhiteButton>
    </form>
  );
};

export default QueryForm;
