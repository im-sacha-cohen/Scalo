// Claude API transport (official SDK). The rest of the AI code only knows `AiTransport`, so tests inject a fake one
// (AppOptions.ai.transport) and never touch the network.
//
// - Structured outputs (`output_config.format`): the model can only answer with JSON matching the schema; the caller
//   validates the JSON again with zod (the answer stays untrusted data).
// - Streaming + `finalMessage()`: no HTTP timeout on long generations; a hard wall-clock deadline aborts the request.
// - The API key is only ever passed to the SDK client: it is never put in a prompt, a log line or an error message.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export type AiErrorCode =
  | 'not_configured'
  | 'invalid_key'
  | 'quota'
  | 'rate_limited'
  | 'refused'
  | 'timeout'
  | 'truncated'
  | 'invalid_output'
  | 'bad_request'
  | 'unavailable';

/** Readable (French) messages shown to the user. None of them contains provider text or the key. */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  not_configured: 'Aucune clé API Claude n’est configurée. Ajoutez la vôtre dans Paramètres → IA.',
  invalid_key: 'La clé API Claude est invalide ou a été révoquée. Vérifiez-la dans Paramètres → IA.',
  quota: 'Le crédit de votre compte Anthropic est épuisé. Ajoutez du crédit sur console.anthropic.com puis réessayez.',
  rate_limited: 'L’API Claude limite temporairement vos requêtes (quota par minute atteint). Réessayez dans un instant.',
  refused: 'Claude a refusé de traiter cette demande. Reformulez votre brief puis réessayez.',
  timeout: 'La génération a pris trop de temps et a été interrompue. Réessayez avec un brief plus court.',
  truncated: 'La réponse de l’IA était trop longue et a été coupée. Réessayez avec un brief plus simple.',
  invalid_output: 'La réponse de l’IA n’avait pas le format attendu et a été rejetée. Réessayez.',
  bad_request: 'L’API Claude a rejeté la requête (modèle indisponible pour cette clé ?). Vérifiez AI_MODEL et votre compte Anthropic.',
  unavailable: 'L’API Claude est momentanément indisponible. Réessayez dans quelques minutes.',
};

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    /** Tokens billed before the failure (refusal, truncated or invalid output). */
    public usage: { inputTokens: number; outputTokens: number; model?: string } = { inputTokens: 0, outputTokens: 0 },
  ) {
    super(AI_ERROR_MESSAGES[code]);
  }
}

export type AiEffort = 'low' | 'medium' | 'high';

export interface AiRequest {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  /** Shape of the expected JSON answer. */
  schema: z.ZodType;
  maxTokens: number;
  effort: AiEffort;
  timeoutMs: number;
}

export interface AiResponse {
  /** Raw JSON text of the answer (validated by the caller). */
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type AiTransport = (req: AiRequest) => Promise<AiResponse>;

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|fable-5-1|sonnet-5-5)$/;
/** `output_config.effort` is rejected by Haiku 4.5. */
const supportsEffort = (model: string) => !model.startsWith('claude-haiku');

function mapError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) return new AiError('timeout');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiError('invalid_key');
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limited');
  if (e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) return new AiError('bad_request');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('unavailable');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 402) return new AiError('quota');
    if (e.status === 413) return new AiError('truncated');
    return new AiError('unavailable');
  }
  return new AiError('unavailable');
}

/**
 * zod → JSON Schema accepted by structured outputs: `anyOf` instead of `oneOf`, no numeric bounds (unsupported by the
 * grammar; the caller validates the answer with the zod schema anyway).
 */
export function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '$schema' || k === 'minimum' || k === 'maximum' || k === 'exclusiveMinimum' || k === 'exclusiveMaximum') continue;
      out[k === 'oneOf' ? 'anyOf' : k] = walk(val);
    }
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export const anthropicTransport: AiTransport = async (req) => {
  const client = new Anthropic({ apiKey: req.apiKey, maxRetries: 1, timeout: req.timeoutMs });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), req.timeoutMs);
  try {
    const fallback = FALLBACK_MODELS.test(req.model);
    const stream = client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { ...(supportsEffort(req.model) ? { effort: req.effort } : {}), format: { type: 'json_schema', schema: outputJsonSchema(req.schema) } },
        // a safety-classifier decline is retried server-side on the model Anthropic recommends for its category
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: abort.signal },
    );
    const message = await stream.finalMessage();
    const usage = {
      inputTokens: (message.usage.input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens ?? 0,
      model: message.model,
    };
    if (message.stop_reason === 'refusal') throw new AiError('refused', usage);
    if (message.stop_reason === 'max_tokens') throw new AiError('truncated', usage);
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, ...usage };
  } catch (e) {
    // never log the SDK error object (request headers carry the key)
    throw mapError(e);
  } finally {
    clearTimeout(timer);
  }
};
