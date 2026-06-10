'use client';

import { useEffect, useRef, useState } from 'react';
import { LedgerId } from '@hashgraph/sdk';
import { DAppConnector } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';
import {
  HederaJsonRpcMethod,
  HederaSessionEvent,
} from '@hashgraph/hedera-wallet-connect/dist/lib/shared';
import {
  CHAIN_IDS,
  PROJECT_IDS,
  getNetworkFromUrl,
  networkLabel,
} from '../auth/walletConnect';
import {
  fetchRakeHolidayQuote,
  payRakeHoliday,
  isTestnetUsdc,
  USDC_TESTNET_FAUCET,
  type PaymentOption,
  type RakeHolidayQuote,
  type RakeHolidayResult,
} from '../lib/x402WalletPay';

/**
 * Rake-holiday purchase modal. Fetches the x402 quote, lets the user pick USDC
 * or HBAR, and pays via WalletConnect. Creates its own DAppConnector and
 * restores the persisted wallet session (the connector lives in AuthFlow, which
 * is unmounted on the dashboard).
 */
export function RakeHolidayModal({
  token,
  onClose,
  onSuccess,
}: {
  token: string;
  onClose: () => void;
  onSuccess?: (result: RakeHolidayResult) => void;
}) {
  const connectorRef = useRef<DAppConnector | null>(null);
  const [quote, setQuote] = useState<RakeHolidayQuote | null>(null);
  const [selected, setSelected] = useState<PaymentOption | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'paying' | 'done'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RakeHolidayResult | null>(null);

  // Load the quote (the payment options) on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = await fetchRakeHolidayQuote(token);
        if (cancelled) return;
        setQuote(q);
        // Default to the HBAR option (no token association needed).
        setSelected(q.accepts.find((a) => a.asset === '0.0.0') ?? q.accepts[0] ?? null);
        setPhase('ready');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('ready');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function getConnector(): Promise<DAppConnector> {
    if (connectorRef.current) return connectorRef.current;
    const net = getNetworkFromUrl();
    const connector = new DAppConnector(
      {
        name: `LazyLotto Agent (${networkLabel(net)})`,
        description: 'LazyLotto rake-holiday payment',
        icons: ['https://docs.lazysuperheroes.com/favicon.svg'],
        url: window.location.origin,
      },
      LedgerId.fromString(net),
      PROJECT_IDS[net],
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
      [CHAIN_IDS[net]],
    );
    await connector.init({ logger: 'error' });
    // Restore (or prompt) a wallet session so signers[0] is available.
    if (connector.signers.length === 0) {
      await connector.openModal();
    }
    connectorRef.current = connector;
    return connector;
  }

  async function handlePay() {
    if (!selected) return;
    setError(null);
    setPhase('paying');
    try {
      const connector = await getConnector();
      const res = await payRakeHoliday(token, selected, connector);
      setResult(res);
      setPhase('done');
      onSuccess?.(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-zinc-100 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-amber-400">Rake Holiday</h2>
            <p className="text-xs text-zinc-500">
              Pay once → <span className="text-amber-400">0% rake</span> on deposits for 30 days.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="Close">
            ✕
          </button>
        </div>

        {phase === 'loading' && <p className="py-6 text-center text-sm text-zinc-400">Loading payment options…</p>}

        {phase === 'done' && result && (
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-emerald-950/50 px-3 py-3 text-sm text-emerald-300">
              ✅ {result.message}
            </div>
            <button onClick={onClose} className="w-full rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black">
              Done
            </button>
          </div>
        )}

        {phase !== 'loading' && phase !== 'done' && quote && (
          <div className="space-y-3">
            <div className="text-sm text-zinc-400">
              Price: <span className="font-semibold text-zinc-100">{quote.accepts[0]?.extra.priceUsd ?? ''}</span> — choose how to pay:
            </div>

            <div className="space-y-2">
              {quote.accepts.map((opt) => {
                const isSel = selected?.asset === opt.asset;
                const label = opt.extra.display ?? `${opt.amount} ${opt.asset}`;
                const isHbar = opt.asset === '0.0.0';
                return (
                  <label
                    key={opt.asset}
                    className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 ${
                      isSel ? 'border-amber-500 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/40'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="pay-asset"
                        checked={isSel}
                        onChange={() => setSelected(opt)}
                        className="accent-amber-500"
                      />
                      <span className="text-sm">
                        <span className="font-semibold">{label}</span>
                        <span className="ml-1 text-xs text-zinc-500">{isHbar ? '(HBAR)' : '(USDC)'}</span>
                      </span>
                    </span>
                    {isTestnetUsdc(opt) && (
                      <a
                        href={USDC_TESTNET_FAUCET}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-amber-400 underline hover:text-amber-300"
                      >
                        Need testnet USDC?
                      </a>
                    )}
                  </label>
                );
              })}
            </div>

            {error && (
              <div className="rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>
            )}

            <button
              onClick={handlePay}
              disabled={phase === 'paying' || !selected}
              className="w-full rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black transition disabled:opacity-50"
            >
              {phase === 'paying' ? 'Confirm in your wallet…' : `Pay ${selected?.extra.display ?? ''} with wallet`}
            </button>
            <p className="text-center text-[11px] text-zinc-600">
              The facilitator pays the network fee; you only send the amount above.
            </p>
          </div>
        )}

        {phase === 'ready' && !quote && error && (
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</div>
            <button onClick={onClose} className="w-full rounded-xl bg-zinc-800 px-4 py-2 text-sm">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
