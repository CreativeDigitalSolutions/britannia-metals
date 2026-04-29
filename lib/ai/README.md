# Britannia Global Markets — AI Prompt Library

`/lib/ai/prompts.ts` exports four prompt templates used by Supabase Edge Functions (Wave 3) to call the Anthropic API. Each template bundles the system prompt, user-message builder, model routing metadata, and a defensive response parser.

---

## Prompt 1 — Headline Relevance Filter (`RELEVANCE_PROMPT`)

**Purpose**: Decides whether a raw news headline is worth spending further tokens on. Culls junior-miner press releases, retail bullion spam, and off-topic macro noise before the sentiment step.

**Model**: `claude-haiku-4-5-20251001`
**Temperature**: `0` (deterministic)
**Max tokens out**: `50`
**Approx system prompt size**: ~750 tokens
**Call frequency**: ~100–200 calls per 2-hour news-ingestion cycle

**Input**: `RelevanceInput` — `{ headline, summary | null, source }`
**Output**: `RelevanceOutput` — `{ relevant: boolean, confidence: "high" | "medium" | "low" }`

**Estimated cost per call**:
- In: ~800 tokens × $1/MTok = **$0.0008**
- Out: ~20 tokens × $5/MTok = **$0.0001**
- Per call total: **~$0.0009**
- Per 2h cycle (150 calls): **~$0.14**

---

## Prompt 2 — Sentiment + Metal Tagging (`CLASSIFY_PROMPT`)

**Purpose**: For headlines that passed the relevance filter, tags which metals are affected and classifies the dominant price sentiment (bullish / bearish / neutral) with a one-sentence trader-voice rationale.

**Model**: `claude-haiku-4-5-20251001`
**Temperature**: `0` (deterministic)
**Max tokens out**: `120`
**Approx system prompt size**: ~1,100 tokens
**Call frequency**: ~50–100 calls per 2-hour cycle (subset that passed relevance)

**Input**: `ClassifyInput` — `{ headline, summary | null, source }`
**Output**: `ClassifyOutput` — `{ metals: Metal[], sentiment: Sentiment, rationale: string }`

**Estimated cost per call**:
- In: ~1,100 tokens × $1/MTok = **$0.0011**
- Out: ~80 tokens × $5/MTok = **$0.0004**
- Per call total: **~$0.0015**
- Per 2h cycle (75 calls): **~$0.11**

---

## Prompt 3 — Morning Brief Generator (`BRIEF_PROMPT`)

**Purpose**: Synthesises the past 24 hours of metals market activity into a single-paragraph morning brief (~80–120 words) in FT/Economist prose. Runs once per weekday at 06:00 UTC.

**Model**: `claude-sonnet-4-6`
**Temperature**: `0.3` (slight warmth for prose quality)
**Max tokens out**: `300`
**Approx system prompt size**: ~1,500 tokens (including two full example outputs)
**Call frequency**: 1 per weekday (~260/year)

**Input**: `BriefInput` — price moves, LME/COMEX arb snapshot, top headlines, upcoming events
**Output**: `BriefOutput` — `{ content: string }` — plain prose, no parser needed

**Estimated cost per call**:
- In: ~2,500 tokens × $3/MTok = **$0.0075**
- Out: ~200 tokens × $15/MTok = **$0.0030**
- Per call total: **~$0.011**
- Per month (22 weekdays): **~$0.24**

---

## Prompt 4 — Per-commodity Explainer (`EXPLAINER_PROMPT`)

**Purpose**: When a trader clicks a metal tile in the dashboard, generates a "why did this move?" explainer: 2–3 sentence summary plus 2–4 key driver bullets. Stretch feature targeted at Wave 4.

**Model**: `claude-sonnet-4-6`
**Temperature**: `0.2`
**Max tokens out**: `250`
**Approx system prompt size**: ~1,200 tokens (including one full example)
**Call frequency**: On-demand (user-triggered)

**Input**: `ExplainerInput` — metal, price, change, curve spread, LME stocks, cancelled warrants, pre-filtered headlines
**Output**: `ExplainerOutput` — `{ summary: string, key_drivers: string[] }`

**Estimated cost per call**:
- In: ~1,500 tokens × $3/MTok = **$0.0045**
- Out: ~150 tokens × $15/MTok = **$0.0023**
- Per call total: **~$0.0068**

---

## Pricing Reference

Anthropic pricing used above (as of April 2025):

| Model | Input | Output |
|---|---|---|
| `claude-haiku-4-5-20251001` | $1 / MTok | $5 / MTok |
| `claude-sonnet-4-6` | $3 / MTok | $15 / MTok |

---

## Testing a Prompt in Isolation

**Prerequisite**: `@anthropic-ai/sdk` is installed (it is listed in `package.json`).

### Run the built-in smoke-test (all four prompts):

```bash
cd britannia-metals
ANTHROPIC_API_KEY=sk-ant-... npx tsx lib/ai/prompts.ts
```

This fires one live API call per prompt against synthetic-but-realistic test data and prints the raw output and parsed result for each.

### Test a single prompt with curl:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "temperature": 0,
    "system": "<paste RELEVANCE_PROMPT.system here>",
    "messages": [{
      "role": "user",
      "content": "headline: LME copper stocks fall to 10-year low\nsummary: (none)\nsource: Reuters"
    }]
  }'
```

### Import and call from a Node script:

```typescript
import { RELEVANCE_PROMPT, parseRelevanceResponse } from './lib/ai/prompts';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const res = await client.messages.create({
  model:       RELEVANCE_PROMPT.model,
  max_tokens:  RELEVANCE_PROMPT.max_tokens,
  temperature: RELEVANCE_PROMPT.temperature,
  system:      RELEVANCE_PROMPT.system,
  messages: [{
    role:    'user',
    content: RELEVANCE_PROMPT.buildUserMessage({
      headline: 'LME copper stocks fall to 10-year low',
      summary:  null,
      source:   'Reuters',
    }),
  }],
});

const text = res.content[0].type === 'text' ? res.content[0].text : '';
const parsed = parseRelevanceResponse(text);
console.log(parsed); // { relevant: true, confidence: 'high' }
```

---

## Integration Notes (Wave 3)

- The `Metal` and `Sentiment` types declared locally in `prompts.ts` should be reconciled with `/lib/metals.ts` and `/types/database.ts` during Wave 3 integration. They are intentionally identical.
- Edge Functions should implement retry logic: if a parser returns `null` (malformed JSON), retry the call once before logging and discarding.
- The `BRIEF_PROMPT` returns plain prose — no parser. Edge Function should `trim()` the response and store directly in `briefs.content`.
- `buildUserMessage` functions are deterministic — safe to call from any runtime context.
