/**
 * Lightweight Anthropic API client for Supabase Edge Functions.
 * Uses fetch directly — no SDK, no dead weight in the Deno bundle.
 * Used by: classify-news, generate-brief
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicCallOptions {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature: number;
}

export interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicResponse> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new AnthropicError('ANTHROPIC_API_KEY not set', 0, false);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new AnthropicError(`Anthropic API ${res.status}: ${body}`, res.status, retryable);
  }

  return await res.json() as AnthropicResponse;
}

/** Retries once on retryable errors (429, 5xx) with exponential backoff. */
export async function callAnthropicWithRetry(opts: AnthropicCallOptions): Promise<AnthropicResponse> {
  try {
    return await callAnthropic(opts);
  } catch (err) {
    if (err instanceof AnthropicError && err.retryable) {
      await new Promise(r => setTimeout(r, 2000));
      return await callAnthropic(opts);
    }
    throw err;
  }
}

/** Extract text from a typical single-content-block response. */
export function extractText(res: AnthropicResponse): string {
  return res.content.map(c => c.text).join('').trim();
}
