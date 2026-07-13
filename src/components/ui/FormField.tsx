import { useEffect, useRef, type ReactNode } from 'react';

interface FormFieldProps {
  label: ReactNode;
  /** Built-in input value. Ignored when `children` is provided. */
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  /** Focus the input on mount and select its current text so a pre-seeded
   *  default value is one-keystroke replaceable (e.g. the date-stamped
   *  default in the Save Snapshot dialog). */
  autoFocus?: boolean;
  /** `sub` renders the compact 10px sub-label used for Lat/Lng, Direction, etc. */
  size?: 'default' | 'sub';
  /** Wrapper classes; defaults to `mb-3`. Pass '' to drop the margin (e.g. in a grid). */
  containerClassName?: string;
  /** Render a custom control (select / textarea / custom input) instead of the built-in input. */
  children?: ReactNode;
}

const labelClasses: Record<'default' | 'sub', string> = {
  default: 'block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1',
  sub: 'block text-[10px] text-warm-gray mb-0.5',
};

export function FormField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  error,
  disabled,
  autoFocus,
  size = 'default',
  containerClassName = 'mb-3',
  children,
}: FormFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [autoFocus]);
  return (
    <div className={containerClassName}>
      <label className={labelClasses[size]}>
        {label}
        {required && <span className="text-coral ml-0.5">*</span>}
      </label>
      {children ?? (
        <input
          ref={inputRef}
          type={type}
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full px-3 py-2 border-2 rounded-lg text-sm font-[var(--font-body)] text-dark-brown bg-cream transition-colors
          ${error ? 'border-red-400 bg-red-50' : 'border-sand'}
          focus:outline-none focus:border-coral focus:bg-white
          disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      )}
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  );
}

interface CheckboxFieldProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Optional helper text under the row. */
  hint?: ReactNode;
  containerClassName?: string;
}

/** Checkbox row — box on the left, label to its right. Companion to FormField. */
export function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
  hint,
  containerClassName = 'mb-3',
}: CheckboxFieldProps) {
  return (
    <div className={containerClassName}>
      <label className="flex items-center gap-2 text-sm text-dark-brown cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="rounded"
        />
        {label}
      </label>
      {hint && <p className="text-[11px] text-warm-gray mt-0.5 ml-6">{hint}</p>}
    </div>
  );
}
