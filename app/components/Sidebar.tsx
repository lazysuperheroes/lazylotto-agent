'use client';

import { useState, useCallback, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Inline SVG icons (16x16)
// ---------------------------------------------------------------------------

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="1" y="3" width="14" height="11" rx="2" />
      <path d="M1 6h14" />
      <circle cx="12" cy="9.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
      <path d="M9 1v4h4" />
      <line x1="5" y1="8" x2="11" y2="8" />
      <line x1="5" y1="11" x2="9" y2="11" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7 3.5-.5 6-3.5 6-7V4L8 1z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { label: 'Connect Wallet', labelAuth: 'Account', href: '/auth', Icon: WalletIcon, adminOnly: false },
  { label: 'Dashboard', href: '/dashboard', Icon: GridIcon, adminOnly: false },
  { label: 'Audit Trail', href: '/audit', Icon: DocumentIcon, adminOnly: false },
  { label: 'Admin', href: '/admin', Icon: ShieldIcon, adminOnly: true },
];

// ---------------------------------------------------------------------------
// User context section (bottom of sidebar)
// ---------------------------------------------------------------------------

function UserContext() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    setAccountId(localStorage.getItem('lazylotto:accountId'));
    setHasSession(!!localStorage.getItem('lazylotto:sessionToken'));
  }, []);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem('lazylotto:sessionToken');
    localStorage.removeItem('lazylotto:accountId');
    localStorage.removeItem('lazylotto:tier');
    localStorage.removeItem('lazylotto:expiresAt');
    localStorage.removeItem('lazylotto:locked');
    // Full reload intentional — clears React state across the whole app
    window.location.href = '/auth';
  }, []);

  const networkName =
    typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_HEDERA_NETWORK
      ? process.env.NEXT_PUBLIC_HEDERA_NETWORK
      : 'Testnet';

  const truncatedId =
    accountId && accountId.length > 14
      ? `${accountId.slice(0, 7)}...${accountId.slice(-4)}`
      : accountId;

  return (
    <div className="border-t border-[#27272a] px-3 py-3">
      {/* Network badge */}
      <span className="mb-2 inline-flex items-center rounded bg-brand/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
        {networkName}
      </span>

      {/* Account badge */}
      {accountId && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-[#a1a1aa]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
          <span className="truncate" title={accountId}>
            {truncatedId}
          </span>
        </div>
      )}

      {/* Disconnect link */}
      {hasSession && (
        <button
          type="button"
          onClick={handleDisconnect}
          className="mt-2 text-[11px] text-[#a1a1aa] underline-offset-2 transition-colors hover:text-destructive hover:underline"
        >
          Disconnect
        </button>
      )}

      {/* Version */}
      <p className="mt-3 text-[10px] text-[#52525b]">
        v{process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Check auth state + admin status for conditional nav
  useEffect(() => {
    const hasToken = !!localStorage.getItem('lazylotto:sessionToken');
    setIsAuthenticated(hasToken);

    const tier = localStorage.getItem('lazylotto:tier') ?? '';
    setIsAdmin(hasToken && (tier === 'admin' || tier === 'operator'));
  }, [pathname]); // Re-check on route change

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('keydown', handleKey);
      return () => document.removeEventListener('keydown', handleKey);
    }
  }, [open]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <>
      {/* ---- Mobile hamburger button ---- */}
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle navigation"
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg border border-[#27272a] bg-[#09090b] text-[#a1a1aa] transition-colors hover:text-[#fafafa] md:hidden"
      >
        {open ? (
          /* X icon */
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="4" x2="16" y2="16" />
            <line x1="16" y1="4" x2="4" y2="16" />
          </svg>
        ) : (
          /* Hamburger icon */
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="5" x2="17" y2="5" />
            <line x1="3" y1="10" x2="17" y2="10" />
            <line x1="3" y1="15" x2="17" y2="15" />
          </svg>
        )}
      </button>

      {/* ---- Overlay (mobile) ---- */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ---- Sidebar ---- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-48 flex-col border-r border-[#27272a] bg-[#09090b] transition-transform duration-200 md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex h-16 items-center px-4">
          <Link href="/" className="flex items-center gap-3">
            <img
              src="https://docs.lazysuperheroes.com/logo.svg"
              alt="LazyLotto"
              width={120}
              height={40}
              className="h-10 w-auto"
            />
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-secondary text-[#fafafa]'
                    : 'text-[#a1a1aa] hover:bg-[#27272a]/50 hover:text-[#fafafa]'
                }`}
              >
                <item.Icon className={isActive ? 'text-[#fafafa]' : 'text-[#a1a1aa]'} />
                {isAuthenticated && item.labelAuth ? item.labelAuth : item.label}
              </Link>
            );
          })}
        </nav>

        {/* User context — pushed to bottom */}
        <div className="mt-auto">
          <UserContext />
        </div>
      </aside>
    </>
  );
}
