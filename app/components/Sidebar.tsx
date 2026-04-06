'use client';

import { useState, useCallback, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LSH_CHARACTERS,
  loadOrPickCharacterIdx,
  persistCharacterIdx,
  randomCharacterIdx,
} from '../lib/characters';

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
  const [characterIdx, setCharacterIdx] = useState(0);

  useEffect(() => {
    setAccountId(localStorage.getItem('lazylotto:accountId'));
    setHasSession(!!localStorage.getItem('lazylotto:sessionToken'));
    setCharacterIdx(loadOrPickCharacterIdx());
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
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_HEDERA_NETWORK) ||
    'testnet';
  const isMainnet = networkName === 'mainnet';

  const truncatedId =
    accountId && accountId.length > 14
      ? `${accountId.slice(0, 7)}…${accountId.slice(-4)}`
      : accountId;

  const character = LSH_CHARACTERS[characterIdx] ?? LSH_CHARACTERS[0]!;
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

  return (
    <div className="border-t-2 border-brand/30 bg-brand/5">
      {/* ── Mascot + name + reroll ────────────────────────────
          Sidebar echo of the hero mascot — persistent across
          every page so the character presence never breaks. The
          reroll die sits in the top-right corner of the panel
          frame (same affordance as /auth) so users who don't
          love their randomly-picked character can swap without
          signing out and back in. */}
      {hasSession && (
        <div className="flex flex-col items-center gap-1 px-3 pt-4 pb-3">
          <div className="relative border-2 border-brand bg-[var(--color-panel)] p-1 panel-shadow-sm">
            <img
              src={character.img}
              alt={character.name}
              width={56}
              height={56}
              className="block h-14 w-14 select-none"
              draggable={false}
            />
            <button
              type="button"
              onClick={() => {
                const nextIdx = randomCharacterIdx();
                setCharacterIdx(nextIdx);
                persistCharacterIdx(nextIdx);
              }}
              aria-label="Change mascot"
              title="Change mascot"
              className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center border-2 border-brand bg-background text-[11px] transition-transform hover:rotate-12 hover:bg-brand/20 focus-visible:rotate-12"
            >
              <span aria-hidden="true">🎲</span>
            </button>
          </div>
          <p className="mt-1 font-pixel text-[8px] uppercase tracking-wider text-brand">
            {character.name}
          </p>
        </div>
      )}

      {/* ── Network + account ─────────────────────────────────
          Both in prominent, high-contrast treatments — the old
          version had these at 10-12px muted grey and they were
          effectively invisible on the dark bg. Now the network
          gets a full-width gold sticker band (brand for mainnet,
          muted for testnet so users don't mistake one for the
          other). Account sits under it in a mono readout. */}
      <div className="px-3 py-3">
        <div
          className={`mb-2 border-2 px-2 py-1 text-center font-pixel text-[9px] uppercase tracking-wider ${
            isMainnet
              ? 'border-brand bg-brand text-background'
              : 'border-brand/40 bg-brand/10 text-brand'
          }`}
        >
          {networkName}
        </div>

        {accountId && (
          <div className="mb-3 flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
              title="Signed in"
              aria-hidden="true"
            />
            <code
              className="truncate font-mono text-[11px] text-foreground"
              title={accountId}
            >
              {truncatedId}
            </code>
          </div>
        )}

        {/* ── Disconnect ─────────────────────────────────────
            Proper button, not a 11px underlined text link.
            Ghost styling so it doesn't compete with nav items,
            but visible and hoverable with clear affordance. */}
        {hasSession && (
          <button
            type="button"
            onClick={handleDisconnect}
            className="w-full border border-secondary px-2 py-1.5 font-pixel text-[8px] uppercase tracking-wider text-muted transition-colors hover:border-destructive hover:text-destructive"
          >
            Disconnect
          </button>
        )}
      </div>

      {/* ── Version ───────────────────────────────────────────
          Now in pixel font so it reads as an "imprint" — the
          corner of a comic book cover, not dead fine print. */}
      <div className="border-t border-brand/20 px-3 py-2 text-center">
        <p className="font-pixel text-[8px] uppercase tracking-wider text-brand/60">
          LazyLotto · v{version}
        </p>
      </div>
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
        className={`fixed inset-y-0 left-0 z-40 flex w-52 flex-col border-r-2 border-brand/20 bg-[#09090b] transition-transform duration-200 md:static md:translate-x-0 ${
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

        {/* Navigation — comic-tab treatment:
            - Sharp corners (no rounded pill)
            - Active item gets a 3px brand-gold left border + darker
              panel-toned background, reading like an open tab on a
              comic-book table of contents
            - Inactive items have a transparent left border so the
              layout doesn't shift when switching tabs
            - Label is Heebo at 14px (readable) with pixel font reserved
              for the active item marker */}
        <nav className="flex flex-1 flex-col gap-0.5 px-0 py-3">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center gap-3 border-l-[3px] px-5 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-brand bg-brand/10 text-foreground'
                    : 'border-transparent text-muted hover:border-brand/40 hover:bg-secondary/40 hover:text-foreground'
                }`}
              >
                <item.Icon
                  className={
                    isActive
                      ? 'text-brand'
                      : 'text-muted transition-colors group-hover:text-brand'
                  }
                />
                <span className="flex-1">
                  {isAuthenticated && item.labelAuth ? item.labelAuth : item.label}
                </span>
                {isActive && (
                  <span
                    className="font-pixel text-[8px] text-brand"
                    aria-hidden="true"
                  >
                    ●
                  </span>
                )}
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
