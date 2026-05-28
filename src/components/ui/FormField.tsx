import { useEffect, useRef } from 'react';

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  /** Focus the input on mount and select its current text so a pre-seeded
   *  default value is one-keystroke replaceable (e.g. the date-stamped
   *  default in the Save Snapshot dialog). */
  autoFocus?: boolean;
}

export function FormField({ label, value, onChange, placeholder, type = 'text', required, error, disabled, autoFocus }: FormFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [autoFocus]);
  return (
    <div className="mb-3">
      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        {label}
        {required && <span className="text-coral ml-0.5">*</span>}
      </label>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`w-full px-3 py-2 border-2 rounded-lg text-sm font-[var(--font-body)] text-dark-brown bg-cream transition-colors
          ${error ? 'border-red-400 bg-red-50' : 'border-sand'}
          focus:outline-none focus:border-coral focus:bg-white
          disabled:opacity-50 disabled:cursor-not-allowed`}
      />
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  );
}
