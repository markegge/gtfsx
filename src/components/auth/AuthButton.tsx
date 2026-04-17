import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface AuthButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  fullWidth?: boolean;
  children: ReactNode;
}

const variantStyles: Record<Variant, string> = {
  primary: 'bg-coral text-white hover:bg-[#d4603a] disabled:bg-coral/60',
  secondary: 'bg-sand text-brown hover:bg-coral-light hover:text-coral disabled:opacity-60',
  danger: 'bg-red-500 text-white hover:bg-red-600 disabled:bg-red-500/60',
  ghost: 'bg-transparent text-warm-gray hover:text-coral disabled:opacity-60',
};

export function AuthButton({
  variant = 'primary',
  fullWidth = false,
  className = '',
  children,
  ...rest
}: AuthButtonProps) {
  return (
    <button
      {...rest}
      className={`px-4 py-2.5 rounded-lg font-heading font-bold text-sm transition-colors disabled:cursor-not-allowed ${
        fullWidth ? 'w-full' : ''
      } ${variantStyles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
