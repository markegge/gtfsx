import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { useEffect, useState } from 'react';
import { getMyForumProfile, type ForumProfile } from '../../services/forumApi';

// Matches the site-wide marketing header used on /about/, /docs/, /learn/*,
// /docs/deep-links/. Keep the structure here in sync with those static pages
// so the chrome looks identical when users cross between marketing pages and
// the forum. Brand-color tokens use the same Tailwind classes the editor
// already uses (coral / sand / cream / dark-brown / warm-gray).

export function CommunityRoot({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const [me, setMe] = useState<ForumProfile | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setMe(null);
      return;
    }
    let cancelled = false;
    getMyForumProfile()
      .then(({ profile }) => {
        if (!cancelled) setMe(profile);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  return (
    <div className="min-h-screen bg-cream">
      <header className="sticky top-0 z-10 bg-white border-b border-sand h-14 flex items-center px-5 gap-4">
        <Link to="/" className="inline-flex items-center gap-2.5 shrink-0">
          <img src="/gtfs-studio-logo.svg" alt="" className="w-11 h-11 max-[720px]:w-9 max-[720px]:h-9" />
          <span className="font-extrabold text-2xl text-coral tracking-tight max-[720px]:text-xl">
            GTFS Studio
          </span>
        </Link>

        <nav className="hidden min-[720px]:flex gap-1 ml-3">
          <NavLink href="/about/">About</NavLink>
          <NavLink href="/docs/">Docs</NavLink>
          <NavLink href="/learn/gtfs/">Learn</NavLink>
          <NavLink href="/docs/deep-links/">Integrations</NavLink>
          <NavLink href="/community" active>Community</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <a
            href="/"
            className="hidden min-[720px]:inline-flex bg-coral text-white px-3.5 py-2 rounded-lg font-semibold text-sm hover:brightness-95 transition-[filter]"
          >
            Open editor
          </a>
          {currentUser ? (
            <Link
              to="/community/profile"
              className="inline-flex"
              title={`${me?.displayName ?? currentUser.displayName} — your community profile`}
            >
              <Avatar
                gravatarHash={me?.gravatarHash ?? null}
                displayName={me?.displayName ?? currentUser.displayName}
                size={36}
              />
            </Link>
          ) : (
            <button
              onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
              className="text-warm-gray text-sm font-semibold hover:text-dark-brown"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

function NavLink({ href, children, active = false }: { href: string; children: React.ReactNode; active?: boolean }) {
  // External links (the static marketing pages) need a full page load —
  // they're not part of the SPA's route table. Internal links (/community)
  // go through the router.
  const isExternal = !href.startsWith('/community');
  const className = `text-sm font-semibold px-3 py-2 rounded-md transition-colors ${
    active ? 'text-dark-brown bg-cream' : 'text-warm-gray hover:text-dark-brown hover:bg-cream'
  }`;
  if (isExternal) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {children}
    </Link>
  );
}
