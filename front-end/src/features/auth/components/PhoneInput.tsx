/**
 * STATE MACHINE: PhoneInput
 *
 * [COUNTRY_SELECTED] <-- country: CountryCode (default US)
 *     |
 *     +--(pick country)-----> country changes, national digits kept,
 *     |                       value recomposed as +<dial><digits>
 *     +--(type digits)------> value = composeE164(country, digits)
 *     +--(type/paste "+..")-> country auto-detected from dial code,
 *                             value = "+"-prefixed digits as typed
 *
 * The outer `value` is always the canonical E.164-ish string (+5255…);
 * the text input displays only the formatted national part.
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  COUNTRY_OPTIONS,
  DEFAULT_COUNTRY,
  composeE164,
  detectCountry,
  detectCountryExact,
  formatNationalDigits,
  getDialCode,
  nationalDigits,
  type CountryCode,
} from '@/lib/phone';

interface PhoneInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Country-selector button styles (mac-app passes its own design tokens). */
  triggerClassName?: string;
  /** Text-input styles (mac-app passes its own design tokens). */
  inputClassName?: string;
}

const DEFAULT_TRIGGER_CLASS =
  'flex h-full items-center gap-1 px-2.5 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-sm';

const DEFAULT_INPUT_CLASS =
  'w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-sm placeholder-navi-black/30 focus:outline-none focus:border-gray-400';

function PhoneInput({
  id,
  value,
  onChange,
  disabled,
  triggerClassName = DEFAULT_TRIGGER_CLASS,
  inputClassName = DEFAULT_INPUT_CLASS,
}: PhoneInputProps) {
  const [country, setCountry] = useState<CountryCode>(DEFAULT_COUNTRY);

  // Re-sync the selector when the outer value carries a different country
  // (paste of a full +52… number, restored form state, etc.). Exact parses
  // only — ambiguous shared-code prefixes (+1 US/CA, +7 RU/KZ) must not
  // override a manually selected country while the user is still typing.
  useEffect(() => {
    const detected = detectCountryExact(value);
    if (detected !== undefined && detected !== country) setCountry(detected);
  }, [value, country]);

  const national = nationalDigits(value, country);
  const display = formatNationalDigits(country, national);
  const selected = COUNTRY_OPTIONS.find((option) => option.code === country);

  const handleTextChange = (raw: string) => {
    if (raw.trim().startsWith('+')) {
      const detected = detectCountry(raw.trim());
      if (detected !== undefined) setCountry(detected);
      const digits = raw.replace(/\D/g, '');
      onChange(digits === '' ? '' : `+${digits}`);
      return;
    }
    onChange(composeE164(country, raw));
  };

  const handleCountryChange = (code: CountryCode) => {
    setCountry(code);
    onChange(composeE164(code, national));
  };

  return (
    <div className="flex gap-2">
      <div className="relative shrink-0">
        <div className={`${triggerClassName} ${disabled ? 'opacity-50' : ''}`}>
          <span aria-hidden="true">{selected?.flag}</span>
          <span>+{getDialCode(country)}</span>
          <ChevronDown className="w-3 h-3 text-gray-400" aria-hidden="true" />
        </div>
        <select
          aria-label="Country code"
          value={country}
          disabled={disabled}
          onChange={(e) => handleCountryChange(e.target.value as CountryCode)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        >
          {COUNTRY_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.flag} {option.name} (+{option.dialCode})
            </option>
          ))}
        </select>
      </div>
      <input
        id={id}
        type="tel"
        placeholder="Phone number"
        value={display}
        onChange={(e) => handleTextChange(e.target.value)}
        required
        className={inputClassName}
        disabled={disabled}
      />
    </div>
  );
}

export default PhoneInput;
