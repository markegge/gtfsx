import type { ReactNode } from 'react';
import { AppBrand } from '../layout/AppBrand';
import { UserMenu } from '../layout/UserMenu';

interface AuthLayoutProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * When true, use a wider main column suitable for pages like My Feeds /
   * Org Settings / Admin that aren't form-shaped.
   */
  wide?: boolean;
}

export function AuthLayout({ title, subtitle, children, footer, wide = false }: AuthLayoutProps) {
  return (
    <div className="min-h-full bg-cream flex flex-col">
      <header className="h-14 bg-white border-b border-sand flex items-center px-3 sm:px-5 gap-2 sm:gap-3 shrink-0">
        <AppBrand mode="link" taglineClassName="hidden xl:inline" />
        <div className="flex-1" />
        <UserMenu />
      </header>
      <main className="flex-1 flex items-start justify-center px-4 py-10 overflow-y-auto">
        <div className={`w-full ${wide ? 'max-w-[960px]' : 'max-w-[480px]'}`}>
          <div className="bg-white rounded-2xl shadow-sm border border-sand p-8">
            <h1 className="font-heading font-extrabold text-2xl text-dark-brown mb-1">{title}</h1>
            {subtitle && <div className="text-sm text-warm-gray mb-5">{subtitle}</div>}
            {children}
          </div>
          {footer && <div className="mt-4 text-center text-sm text-warm-gray">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
