import { useEffect, useState } from 'react';

interface SearchBarProps {
  initial?: string;
  onSubmit: (q: string) => void;
  placeholder?: string;
}

/** Compact search input. Submits on Enter; clear via the × button. */
export function SearchBar({ initial = '', onSubmit, placeholder = 'Search the community…' }: SearchBarProps) {
  const [q, setQ] = useState(initial);

  // If the URL's `q` changes (e.g. user navigates to a new search result page),
  // mirror that into the input so it stays in sync.
  useEffect(() => {
    setQ(initial);
  }, [initial]);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        if (v) onSubmit(v);
      }}
      className="relative w-full"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-warm-gray"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full h-9 pl-8 pr-7 rounded-full border border-sand bg-cream/50 text-sm text-dark-brown placeholder:text-warm-gray focus:bg-white focus:border-coral focus:outline-none transition-colors"
      />
      {q && (
        <button
          type="button"
          onClick={() => setQ('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full text-warm-gray hover:text-dark-brown text-sm leading-none flex items-center justify-center"
        >
          ×
        </button>
      )}
    </form>
  );
}
