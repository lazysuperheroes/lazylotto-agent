'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSessionToken } from '../lib/session';
import { ChatPanel } from './ChatPanel';

/**
 * /chat — the conversational interface to the LazyLotto agent.
 *
 * Auth-gated the same way as the dashboard: requires a session token in
 * localStorage (set after WalletConnect sign-in). Redirects to /auth if absent.
 * The token is passed to ChatPanel, which threads it as a Bearer header to
 * /api/chat so the server scopes every tool call to this user.
 */
export default function ChatPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const t = getSessionToken();
    if (!t) {
      router.replace('/auth');
      return;
    }
    setToken(t);
    setChecked(true);
  }, [router]);

  if (!checked || !token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Loading…
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-amber-400">
            LazyLotto Agent
          </h1>
          <p className="text-xs text-zinc-500">
            Your balance, plays, and on-chain activity — just ask.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-zinc-400 transition hover:text-amber-400"
        >
          Dashboard →
        </Link>
      </header>
      <div className="flex-1 overflow-hidden">
        <ChatPanel token={token} />
      </div>
    </main>
  );
}
