import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

interface AuthLayoutProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="min-h-full bg-cream flex flex-col">
      <header className="h-14 bg-white border-b border-sand flex items-center px-5 shrink-0">
        <Link
          to="/"
          className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral hover:opacity-80 transition-opacity"
        >
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#E8734A" />
            <path
              d="M6 24 C10 24, 10 8, 16 8 S22 24, 26 24"
              stroke="#FFF8F0"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <circle cx="8" cy="22" r="2.5" fill="#FFF8F0" />
            <circle cx="16" cy="8" r="2.5" fill="#FFF8F0" />
            <circle cx="24" cy="22" r="2.5" fill="#FFF8F0" />
            <rect x="12" y="14" width="8" height="5" rx="1.5" fill="#FFF8F0" />
            <rect x="13.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A" />
            <rect x="16.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A" />
            <circle cx="14" cy="19.5" r="1" fill="#FFF8F0" />
            <circle cx="18" cy="19.5" r="1" fill="#FFF8F0" />
          </svg>
          GTFS Builder
        </Link>
      </header>
      <main className="flex-1 flex items-start justify-center px-4 py-10 overflow-y-auto">
        <div className="w-full max-w-[480px]">
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
