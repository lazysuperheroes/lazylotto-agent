/**
 * Chat handler — isolated here (not in route.ts) so the route can flag-gate and
 * dynamic-import it. All static Agent Kit / AI SDK imports live in THIS module,
 * so when CHAT_ENABLED is off the route never pulls this module graph.
 *
 * Cost guardrails (so a demo stays within budget and nobody can burn credits on
 * off-topic requests): a strict on-topic system prompt, a per-turn output-token
 * cap, an input-length cap, history trimming, and a bounded tool-step count.
 * The per-user DAILY message cap lives in route.ts (before this module loads).
 */

import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  wrapLanguageModel,
  type UIMessage,
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { loadFeatureConfig } from '~/config/features';
import { buildChatToolkit } from '~/agent-kit/toolkit';

/**
 * Build the scope-restricting system prompt. When `allowPlay` is set the assistant
 * gains the confirmed play flow; otherwise it stays read-only and points play
 * requests at the dashboard.
 */
function buildSystemPrompt(allowPlay: boolean): string {
  const playInScope = allowPlay
    ? '\n- Starting a play session for the signed-in user — but ONLY after they explicitly confirm.'
    : '';
  const fundsRule = allowPlay
    ? '- You CAN start a play session for the signed-in user, but it spends their balance, so ALWAYS confirm first: when asked to play, call multi_user_play with confirm=false, relay the confirmation prompt it returns, then WAIT. Call multi_user_play with confirm=true ONLY after the user clearly says yes in their LATEST message — never on your own initiative. You cannot withdraw; for withdrawals, point to the dashboard.'
    : "- You cannot move funds. If asked to play or withdraw, say it's coming soon and point to the dashboard.";

  return `You are the LazyLotto assistant — a NARROWLY-SCOPED helper for the LazyLotto autonomous lottery service on the Hedera network. You are not a general-purpose assistant.

STRICTLY IN SCOPE (the only things you help with):
- The signed-in user's LazyLotto account: their balance, how to deposit/fund, and their play history.
- Read-only Hedera facts about the user's own account or LazyLotto (account balance, tokens, a transaction, the network) via your on-chain query tools.
- How LazyLotto works, at a high level.${playInScope}

OUT OF SCOPE — refuse in ONE short, friendly sentence and steer back to LazyLotto. Do NOT attempt:
- General knowledge, news, opinions, or advice unrelated to LazyLotto.
- Coding, math, writing, translation, role-play, or any general-assistant task.
- Other apps, chains, tokens, or protocols unrelated to the user's LazyLotto activity.
- Anything needing information outside your available tools.

Rules:
- Act ONLY for the currently signed-in user. Never reveal or act on another user's data.
- Prefer a tool call over guessing. If a question is neither answerable by your tools nor about LazyLotto, decline briefly.
${fundsRule}
- Be concise — a few sentences at most. Format token balances clearly. Never write long essays.`;
}

/** Extract the plain text of a UI message's text parts. */
function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('');
}

export async function handleChat(
  request: Request,
  authToken: string,
): Promise<Response> {
  const cfg = loadFeatureConfig();
  const origin = new URL(request.url).origin;
  const { messages } = (await request.json()) as { messages: UIMessage[] };

  // Guardrail: cap the size of the latest user message.
  const latest = messages[messages.length - 1];
  if (messageText(latest).length > cfg.chat.maxInputChars) {
    return new Response(
      JSON.stringify({
        error: `Message too long (max ${cfg.chat.maxInputChars} characters).`,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Guardrail: trim history to the most recent N messages (bounds input tokens).
  const trimmed = messages.slice(-cfg.chat.maxHistoryMessages);

  const toolkit = buildChatToolkit({
    origin,
    authToken,
    allowPlay: cfg.chat.allowPlay,
  });

  const result = streamText({
    model: wrapLanguageModel({
      model: anthropic(cfg.chat.model),
      middleware: toolkit.middleware(),
    }),
    system: buildSystemPrompt(cfg.chat.allowPlay),
    messages: await convertToModelMessages(trimmed),
    tools: toolkit.getTools(),
    // Cost guardrails.
    maxOutputTokens: cfg.chat.maxOutputTokens,
    stopWhen: stepCountIs(cfg.chat.maxSteps),
  });

  return result.toUIMessageStreamResponse();
}
