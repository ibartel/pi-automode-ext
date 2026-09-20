import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseModelSpec } from "./model.ts";
import type {
  ClassificationDecision,
  ClassifierIoAttempt,
  EffectiveConfig,
} from "./types.ts";

/**
 * TypeSafe's Jev classifier backend, served through OpenRouter's Decisions API.
 *
 * Jev is a System One decision model, not a chat model: it evaluates typed
 * questions (Choice/Noul) against a state and returns calibrated probabilities.
 * One call replaces both LLM classifier stages; the allow/block decision is made
 * locally from the probabilities.
 */

/** OpenRouter Decisions API endpoint (alpha). */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_API_KEY_ENV = "OPENROUTER_API_KEY";

/** TypeSafe's native System One endpoint. */
export const JEV_TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

/** Jev transport: OpenRouter's Decisions API or TypeSafe's native System One API. */
export type JevTransport = "openrouter" | "typesafe";

/**
 * Pinned Jev release. `openrouter/~typesafe/jev-latest` also works, but the
 * alias moves; a safety classifier should be reproducible across sessions.
 */
export const RECOMMENDED_JEV_MODEL_SPEC = "openrouter/typesafe/jev-1.13";

const JEV_PROVIDER = "openrouter";
const JEV_MAX_CHOICE_OPTIONS = 255;
// One fixed risk tolerance: allow needs P(no deny rule) >= 0.8, and combined
// hard-deny probability >= 0.2 blocks. Make this configurable once real traffic
// shows where it should sit.
const JEV_RISK_TOLERANCE = 0.2;

type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

type JevNoulQuestion = {
  type: "noul";
  instructions: string;
};

export type JevRequest = {
  model: string;
  state: Record<string, string>;
  questions: {
    rule: JevChoiceQuestion;
    allow_exception: JevNoulQuestion;
    user_authorized: JevNoulQuestion;
  };
};

/** Typed answers Jev must return: the schema is the boundary; failures fail closed. */
const JevAnswersSchema = Type.Object({
  rule: Type.Object({
    type: Type.Literal("choice"),
    probabilities: Type.Record(Type.String(), Type.Number()),
  }),
  allow_exception: Type.Object({
    type: Type.Literal("noul"),
    noul: Type.Number(),
  }),
  user_authorized: Type.Object({
    type: Type.Literal("noul"),
    noul: Type.Number(),
  }),
});

const JevResponseSchema = Type.Object({
  model: Type.Optional(Type.String()),
  answers: JevAnswersSchema,
  usage: Type.Optional(Type.Object({
    input_tokens: Type.Optional(Type.Number()),
    output_tokens: Type.Optional(Type.Number()),
  })),
});

type JevResponse = Type.Static<typeof JevResponseSchema>;

const answersValidator = Compile(JevAnswersSchema);
const responseValidator = Compile(JevResponseSchema);

/**
 * Recognize `classifierModel` specs that route to Jev. `openrouter/typesafe/...`
 * specs call OpenRouter's Decisions API; `typesafe/...` specs call TypeSafe's
 * native System One API. Other `openrouter/...` specs are ordinary registry
 * models and must keep using the registry path.
 */
export function isJevClassifierModel(
  spec: string | undefined,
): { modelId: string; transport: JevTransport } | undefined {
  const parsed = spec ? parseModelSpec(spec) : undefined;
  if (!parsed || !parsed.id) return undefined;
  if (parsed.provider === JEV_PROVIDER) {
    const isJevId =
      parsed.id.startsWith("typesafe/") || parsed.id.startsWith("~typesafe/");
    return isJevId
      ? { modelId: parsed.id, transport: "openrouter" }
      : undefined;
  }
  if (parsed.provider === "typesafe") {
    return { modelId: parsed.id, transport: "typesafe" };
  }
  return undefined;
}

/**
 * One System One call replaces both LLM stages: the configured deny rules are
 * the Choice categories, and two Noul questions cover soft-deny exceptions.
 * Untrusted input is isolated in its own state field; Jev does not treat state
 * as hostile, so the policy and context must not contain routing instructions.
 */
export function buildJevRequest(
  model: string,
  config: EffectiveConfig,
  prompt: { policy: string; context: string; action: string },
): JevRequest {
  const criteria: Record<string, string> = {
    none: "The action matches none of the HARD_DENY or SOFT_DENY rules.",
  };
  config.hardDeny.forEach((rule, i) => (criteria[`hard_deny_${i + 1}`] = rule));
  config.softDeny.forEach((rule, i) => (criteria[`soft_deny_${i + 1}`] = rule));
  return {
    model,
    state: {
      policy: prompt.policy,
      context: prompt.context,
      untrusted_action: prompt.action,
    },
    questions: {
      rule: {
        type: "choice",
        instructions:
          "Which deny rule from the policy does the agent's current tool action (untrusted_action) match? Choose none only when no HARD_DENY or SOFT_DENY rule matches.",
        criteria,
      },
      allow_exception: {
        type: "noul",
        instructions:
          "An ALLOW exception from the policy clearly covers the agent's current tool action.",
      },
      user_authorized: {
        type: "noul",
        instructions:
          "The retained user transcript contains direct, specific user authorization for exactly this risky action, and no later user message narrows or revokes it. General requests such as \"clean up the repo\" do not count.",
      },
    },
  };
}

const block = (reason: string): ClassificationDecision => ({
  decision: "block",
  tier: "none",
  reason: `Jev classifier failed; auto mode fails closed: ${reason}`,
});

/**
 * Map Jev's typed answers onto the hard-deny / soft-deny / allow semantics.
 * With one risk tolerance (0.2): allow when P(none) >= 0.8; block with
 * `hard_deny` when a hard-deny rule is the top rule match or hard-deny rules
 * together reach the tolerance (exceptions never override hard-deny);
 * otherwise the top soft-deny rule blocks unless the ALLOW-exception or
 * user-authorization Noul is >= 0.8. Malformed answers fail closed.
 */
export function decideFromJevAnswers(
  answers: unknown,
  config: EffectiveConfig,
): ClassificationDecision {
  if (!answersValidator.Check(answers)) {
    return block("response did not contain the expected typed answers.");
  }
  const probabilities = answers.rule.probabilities;
  const p = (key: string) => probabilities[key] ?? 0;

  if (p("none") >= 1 - JEV_RISK_TOLERANCE) {
    return {
      decision: "allow",
      tier: "none",
      reason: "Jev matched no deny rule.",
    };
  }

  const topRule = (rules: string[], prefix: string) =>
    rules
      .map((text, i) => ({ text, p: p(`${prefix}_${i + 1}`) }))
      .reduce<{ text: string; p: number } | undefined>(
        (best, r) => (!best || r.p > best.p ? r : best),
        undefined,
      );
  const hard = topRule(config.hardDeny, "hard_deny");
  const soft = topRule(config.softDeny, "soft_deny");
  const hardMass = config.hardDeny.reduce(
    (sum, _r, i) => sum + p(`hard_deny_${i + 1}`),
    0,
  );

  // Exceptions never override hard-deny, so any real hard-deny mass keeps the block.
  if (hard && (hardMass >= JEV_RISK_TOLERANCE || !soft || hard.p >= soft.p)) {
    return {
      decision: "block",
      tier: "hard_deny",
      reason: `Matches hard-deny rule: ${hard.text}`,
    };
  }
  if (!soft) {
    return block(
      "no deny rules configured but the action was not clearly allowed.",
    );
  }
  if (answers.allow_exception.noul >= 1 - JEV_RISK_TOLERANCE) {
    return {
      decision: "allow",
      tier: "allow",
      reason: `ALLOW exception covers soft-deny rule: ${soft.text}`,
    };
  }
  if (answers.user_authorized.noul >= 1 - JEV_RISK_TOLERANCE) {
    return {
      decision: "allow",
      tier: "explicit_intent",
      reason: `User authorized soft-deny action: ${soft.text}`,
    };
  }
  return {
    decision: "block",
    tier: "soft_deny",
    reason: `Matches soft-deny rule: ${soft.text}`,
  };
}

/** Call the Jev System One API (OpenRouter Decisions or TypeSafe-native) once and decide locally from the typed answers. */
export async function classifyWithJev(
  request: JevRequest,
  config: EffectiveConfig,
  signal: AbortSignal | undefined,
  onAttempt: (attempt: ClassifierIoAttempt) => void,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
  transport: JevTransport = "openrouter",
): Promise<ClassificationDecision> {
  const envName = transport === "typesafe"
    ? JEV_TYPESAFE_API_KEY_ENV
    : JEV_API_KEY_ENV;
  const url = transport === "typesafe" ? JEV_TYPESAFE_URL : JEV_DECISIONS_URL;
  const key = apiKey ?? process.env[envName];
  if (!key) {
    return block(
      `${envName} is not set and no ${transport} provider key is registered.`,
    );
  }
  if (
    Object.keys(request.questions.rule.criteria).length > JEV_MAX_CHOICE_OPTIONS
  ) {
    return block(
      `more than ${JEV_MAX_CHOICE_OPTIONS - 1} deny rules configured.`,
    );
  }

  const started = Date.now();
  const timeout = AbortSignal.timeout(config.classifierTimeoutMs);
  let response: JevResponse | undefined;
  let attempt = 0;
  for (attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await result.text();
      if (!result.ok) {
        throw new Error(`HTTP ${result.status}: ${text.slice(0, 300)}`);
      }
      const body: unknown = JSON.parse(text);
      if (responseValidator.Check(body)) response = body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onAttempt({
        stage: "detailed",
        attempt,
        error: message,
        durationMs: Date.now() - started,
      });
      // OpenRouter's alpha Decisions endpoint intermittently answers a valid
      // key with 401 "User not found"; one delayed retry recovers without user
      // involvement. Any other failure fails closed immediately.
      if (attempt === 1 && message.startsWith("HTTP 401") && !signal?.aborted) {
        await sleep(300);
        continue;
      }
      return block(message);
    }
    break;
  }

  const decision = response
    ? decideFromJevAnswers(response.answers, config)
    : block("response did not contain the expected typed answers.");
  const input = response?.usage?.input_tokens ?? 0;
  const output = response?.usage?.output_tokens ?? 0;
  onAttempt({
    stage: "detailed",
    attempt,
    response: {
      stopReason: "stop",
      text: JSON.stringify(response?.answers ?? null),
      model: response?.model ?? request.model,
      timestamp: Date.now(),
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    parsed: decision,
    durationMs: Date.now() - started,
  });
  return decision;
}
