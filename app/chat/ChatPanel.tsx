'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

/**
 * Chat panel wired to /api/chat via the AI SDK UI message stream. The session
 * Bearer token is threaded on every request; the server scopes all tool calls
 * to that user. Only text parts are rendered (tool calls run server-side and
 * surface as the assistant's text answer).
 */
export function ChatPanel({ token }: { token: string }) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        headers: { Authorization: `Bearer ${token}` },
      }),
    [token],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-10 text-center text-sm text-zinc-400">
            <p className="mb-2 font-semibold text-amber-400">
              Ask the LazyLotto agent
            </p>
            <p>
              Try <em>“What’s my balance?”</em> or{' '}
              <em>“Show my recent plays.”</em>
            </p>
            <p className="mt-2 text-xs text-zinc-600">
              I only help with your LazyLotto account and on-chain activity.
            </p>
          </div>
        )}

        {messages.map((m) => {
          const text = m.parts
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join('');
          const isUser = m.role === 'user';
          // Skip empty assistant bubbles (e.g. a turn that's only tool calls
          // before any text has streamed in).
          if (!isUser && !text) return null;
          return (
            <div
              key={m.id}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                  isUser
                    ? 'bg-amber-500 text-black'
                    : 'bg-zinc-800 text-zinc-100'
                }`}
              >
                {text}
              </div>
            </div>
          );
        })}

        {status === 'submitted' && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-zinc-800 px-4 py-2 text-sm text-zinc-400">
              the agent is thinking…
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">
            {error.message || 'Something went wrong. Is chat enabled on the server?'}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || status !== 'ready') return;
          sendMessage({ text });
          setInput('');
        }}
        className="flex gap-2 border-t border-zinc-800 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={status !== 'ready'}
          maxLength={1000}
          placeholder="Ask about your balance, plays, or Hedera account…"
          className="flex-1 rounded-xl bg-zinc-900 px-4 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none ring-1 ring-zinc-800 focus:ring-amber-500"
        />
        <button
          type="submit"
          disabled={status !== 'ready' || !input.trim()}
          className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black transition disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
