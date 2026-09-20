import test from "node:test";
import assert from "node:assert/strict";
import {
	buildJevRequest,
	classifyWithJev,
	decideFromJevAnswers,
	defaultClassifyAction,
	isJevClassifierModel,
	JEV_API_KEY_ENV,
	JEV_DECISIONS_URL,
	JEV_TYPESAFE_API_KEY_ENV,
	JEV_TYPESAFE_URL,
	type ClassifierIoAttempt,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx } from "./test-helpers.ts";

const config = {
	...baseConfig(),
	hardDeny: ["Exfiltrating secrets."],
	softDeny: ["Force pushing.", "Production deploys."],
};

function answers(
	probabilities: Record<string, number>,
	allow = 0,
	authorized = 0,
) {
	return {
		rule: { type: "choice", choice: "x", probabilities, confidence: 0.9 },
		allow_exception: { type: "noul", noul: allow },
		user_authorized: { type: "noul", noul: authorized },
	};
}

test("OpenRouter and TypeSafe-native Jev specs route to their transports", () => {
	assert.deepEqual(isJevClassifierModel("openrouter/typesafe/jev-1.13"), {
		modelId: "typesafe/jev-1.13",
		transport: "openrouter",
	});
	assert.deepEqual(isJevClassifierModel("openrouter/~typesafe/jev-latest"), {
		modelId: "~typesafe/jev-latest",
		transport: "openrouter",
	});
	// TypeSafe-native specs call the System One API directly.
	assert.deepEqual(isJevClassifierModel("typesafe/jev-latest"), {
		modelId: "jev-latest",
		transport: "typesafe",
	});
	assert.deepEqual(isJevClassifierModel("typesafe/jev-1.13.0"), {
		modelId: "jev-1.13.0",
		transport: "typesafe",
	});
	// Real OpenRouter registry models must keep using the registry path.
	assert.equal(
		isJevClassifierModel("openrouter/@preset/nvidia-nemotron-3-nano-30b-a3b-fast"),
		undefined,
	);
	assert.equal(isJevClassifierModel("openrouter/gpt-5.6-luna"), undefined);
	assert.equal(isJevClassifierModel("openrouter/"), undefined);
	assert.equal(isJevClassifierModel("typesafe/"), undefined);
	assert.equal(isJevClassifierModel(undefined), undefined);
});

test("deny rules become Choice criteria plus the none option", () => {
	const request = buildJevRequest("typesafe/jev-1.13", config, {
		policy: "POLICY",
		context: "CONTEXT",
		action: "ACTION",
	});
	assert.equal(request.model, "typesafe/jev-1.13");
	assert.deepEqual(request.state, {
		policy: "POLICY",
		context: "CONTEXT",
		untrusted_action: "ACTION",
	});
	assert.deepEqual(Object.keys(request.questions.rule.criteria), [
		"none",
		"hard_deny_1",
		"soft_deny_1",
		"soft_deny_2",
	]);
	assert.equal(request.questions.rule.type, "choice");
	assert.equal(request.questions.allow_exception.type, "noul");
	assert.equal(request.questions.user_authorized.type, "noul");
});

test("Jev answers map onto deny tiers and fail closed", () => {
	assert.equal(
		decideFromJevAnswers(answers({ none: 0.95 }), config).decision,
		"allow",
	);
	assert.deepEqual(
		decideFromJevAnswers(answers({ none: 0.1, hard_deny_1: 0.9 }, 1, 1), config),
		{
			decision: "block",
			tier: "hard_deny",
			reason: "Matches hard-deny rule: Exfiltrating secrets.",
		},
	);
	assert.deepEqual(
		decideFromJevAnswers(answers({ none: 0.1, soft_deny_2: 0.9 }), config),
		{
			decision: "block",
			tier: "soft_deny",
			reason: "Matches soft-deny rule: Production deploys.",
		},
	);
	assert.equal(
		decideFromJevAnswers(answers({ none: 0.1, soft_deny_1: 0.9 }, 0.9), config)
			.tier,
		"allow",
	);
	assert.equal(
		decideFromJevAnswers(answers({ none: 0.1, soft_deny_1: 0.9 }, 0, 0.9), config)
			.tier,
		"explicit_intent",
	);
	// Hard-deny mass beats a soft-deny exception even when soft-deny is the top pick.
	assert.equal(
		decideFromJevAnswers(
			answers({ none: 0.2, soft_deny_1: 0.5, hard_deny_1: 0.3 }, 1, 1),
			config,
		).tier,
		"hard_deny",
	);
	// Hard-deny is the top rule match even below the mass threshold.
	assert.equal(
		decideFromJevAnswers(
			answers({ none: 0.6, soft_deny_1: 0.15, hard_deny_1: 0.25 }),
			config,
		).tier,
		"hard_deny",
	);
	// Uncertain "none" is not an allow.
	assert.equal(
		decideFromJevAnswers(answers({ none: 0.7, soft_deny_1: 0.3 }), config)
			.decision,
		"block",
	);
	// All rule probabilities missing: hard and soft tie at zero and the more
	// severe tier wins (fail closed).
	assert.equal(
		decideFromJevAnswers(answers({ none: 0.1 }), config).tier,
		"hard_deny",
	);
	assert.equal(
		decideFromJevAnswers({ rule: { type: "noul" } }, config).decision,
		"block",
	);
	assert.equal(decideFromJevAnswers(undefined, config).decision, "block");
});

test("classifyWithJev posts to the OpenRouter Decisions API and fails closed", async () => {
	const request = buildJevRequest("typesafe/jev-1.13", config, {
		policy: "P",
		context: "C",
		action: "A",
	});

	const previous = process.env[JEV_API_KEY_ENV];
	process.env[JEV_API_KEY_ENV] = "test-key";
	try {
		let sent: { url: string; init: RequestInit } | undefined;
		const attempts: ClassifierIoAttempt[] = [];
		const ok: typeof fetch = async (input, init) => {
			sent = { url: String(input), init: init ?? {} };
			return new Response(
				JSON.stringify({
					model: "typesafe/jev-1.13",
					answers: answers({ none: 0.99 }),
					usage: { input_tokens: 10, output_tokens: 3 },
				}),
			);
		};
		const decision = await classifyWithJev(
			request,
			config,
			undefined,
			(a) => attempts.push(a),
			undefined,
			ok,
		);
		assert.equal(decision.decision, "allow");
		assert.equal(sent?.url, JEV_DECISIONS_URL);
		assert.equal(
			(sent?.init.headers as Record<string, string>).authorization,
			"Bearer test-key",
		);
		assert.deepEqual(JSON.parse(sent?.init.body as string), request);
		assert.equal(attempts[0]?.response?.usage.totalTokens, 13);

		const failing: typeof fetch = async () =>
			new Response("nope", { status: 429 });
		const blocked = await classifyWithJev(
			request,
			config,
			undefined,
			() => {},
			undefined,
			failing,
		);
		assert.equal(blocked.decision, "block");
		assert.match(blocked.reason, /HTTP 429/);

		// A 200 response without typed answers fails closed too.
		const malformed: typeof fetch = async () =>
			new Response(JSON.stringify({ model: "typesafe/jev-1.13" }));
		const invalid = await classifyWithJev(
			request,
			config,
			undefined,
			() => {},
			undefined,
			malformed,
		);
		assert.equal(invalid.decision, "block");

		delete process.env[JEV_API_KEY_ENV];
		const noKey = await classifyWithJev(
			request,
			config,
			undefined,
			() => {},
			undefined,
			ok,
		);
		assert.match(noKey.reason, new RegExp(`${JEV_API_KEY_ENV} is not set`));
	} finally {
		if (previous === undefined) delete process.env[JEV_API_KEY_ENV];
		else process.env[JEV_API_KEY_ENV] = previous;
	}
});

test("classifyWithJev retries a 401 once before failing closed", async () => {
	const request = buildJevRequest("typesafe/jev-1.13", config, {
		policy: "P",
		context: "C",
		action: "A",
	});
	const previous = process.env[JEV_API_KEY_ENV];
	process.env[JEV_API_KEY_ENV] = "test-key";
	try {
		// OpenRouter's alpha Decisions endpoint intermittently answers a valid
		// key with 401 "User not found"; a single retry must recover.
		let calls = 0;
		const attempts: ClassifierIoAttempt[] = [];
		const flaky: typeof fetch = async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(
					JSON.stringify({ error: { message: "User not found.", code: 401 } }),
					{ status: 401 },
				);
			}
			return new Response(
				JSON.stringify({
					model: "typesafe/jev-1.13",
					answers: answers({ none: 0.99 }),
					usage: { input_tokens: 10, output_tokens: 3 },
				}),
			);
		};
		const decision = await classifyWithJev(
			request,
			config,
			undefined,
			(a) => attempts.push(a),
			undefined,
			flaky,
		);
		assert.equal(decision.decision, "allow");
		assert.equal(calls, 2);
		assert.equal(attempts.length, 2);
		assert.match(attempts[0]?.error ?? "", /HTTP 401/);

		// A persistent 401 still fails closed after the retry.
		const always401: typeof fetch = async () =>
			new Response(
				JSON.stringify({ error: { message: "User not found.", code: 401 } }),
				{ status: 401 },
			);
		const blockedAttempts: ClassifierIoAttempt[] = [];
		const blocked = await classifyWithJev(
			request,
			config,
			undefined,
			(a) => blockedAttempts.push(a),
			undefined,
			always401,
		);
		assert.equal(blocked.decision, "block");
		assert.match(blocked.reason, /HTTP 401/);
		assert.equal(blockedAttempts.length, 2);

		// Other HTTP errors do not retry.
		let deniedCalls = 0;
		const forbidden: typeof fetch = async () => {
			deniedCalls += 1;
			return new Response("nope", { status: 403 });
		};
		const forbiddenAttempts: ClassifierIoAttempt[] = [];
		const forbiddenDecision = await classifyWithJev(
			request,
			config,
			undefined,
			(a) => forbiddenAttempts.push(a),
			undefined,
			forbidden,
		);
		assert.equal(forbiddenDecision.decision, "block");
		assert.equal(deniedCalls, 1);
		assert.equal(forbiddenAttempts.length, 1);
	} finally {
		if (previous === undefined) delete process.env[JEV_API_KEY_ENV];
		else process.env[JEV_API_KEY_ENV] = previous;
	}
});

test("defaultClassifyAction routes Jev models without the model registry", async () => {
	const previous = process.env[JEV_API_KEY_ENV];
	process.env[JEV_API_KEY_ENV] = "test-key";
	const originalFetch = globalThis.fetch;
	let fetchedUrl: string | undefined;
	const stub: typeof fetch = async (input) => {
		fetchedUrl = String(input);
		return new Response(
			JSON.stringify({
				model: "typesafe/jev-1.13",
				answers: answers({ none: 0.97 }),
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
	};
	globalThis.fetch = stub;
	try {
		const ctx = createFakeCtx([], {
			modelRegistry: {
				find() {
					throw new Error("Jev classification must not use the model registry");
				},
				async getApiKeyAndHeaders() {
					throw new Error("Jev classification must not use the model registry");
				},
			},
		});
		const result = await defaultClassifyAction(
			ctx,
			{ ...config, classifierModel: "openrouter/typesafe/jev-1.13" },
			"rm -rf /",
			"",
		);
		assert.equal(result.decision, "allow");
		assert.equal(fetchedUrl, JEV_DECISIONS_URL);
		assert.equal(result.io?.model, "openrouter/typesafe/jev-1.13");
	} finally {
		globalThis.fetch = originalFetch;
		if (previous === undefined) delete process.env[JEV_API_KEY_ENV];
		else process.env[JEV_API_KEY_ENV] = previous;
	}
});

test("classifyWithJev prefers an explicitly resolved key over the environment", async () => {
	const request = buildJevRequest("typesafe/jev-1.13", config, {
		policy: "P",
		context: "C",
		action: "A",
	});
	const previous = process.env[JEV_API_KEY_ENV];
	delete process.env[JEV_API_KEY_ENV];
	try {
		let sent: { init: RequestInit } | undefined;
		const ok: typeof fetch = async (_input, init) => {
			sent = { init: init ?? {} };
			return new Response(
				JSON.stringify({
					model: "typesafe/jev-1.13",
					answers: answers({ none: 0.99 }),
				}),
			);
		};
		const decision = await classifyWithJev(
			request,
			config,
			undefined,
			() => {},
			"explicit-key",
			ok,
		);
		assert.equal(decision.decision, "allow");
		assert.equal(
			(sent?.init.headers as Record<string, string>).authorization,
			"Bearer explicit-key",
		);
	} finally {
		if (previous === undefined) delete process.env[JEV_API_KEY_ENV];
		else process.env[JEV_API_KEY_ENV] = previous;
	}
});

test("defaultClassifyAction falls back to a registered openrouter provider key", async () => {
	const previous = process.env[JEV_API_KEY_ENV];
	delete process.env[JEV_API_KEY_ENV];
	const originalFetch = globalThis.fetch;
	let authHeader: string | undefined;
	const stub: typeof fetch = async (_input, init) => {
		authHeader = (init?.headers as Record<string, string> | undefined)
			?.authorization;
		return new Response(
			JSON.stringify({
				model: "typesafe/jev-1.13",
				answers: answers({ none: 0.97 }),
			}),
		);
	};
	globalThis.fetch = stub;
	try {
		const ctx = createFakeCtx([], {
			modelRegistry: {
				find() {
					throw new Error(
						"Jev classification must not resolve the model through the registry",
					);
				},
				getAvailable() {
					return [{ provider: "openrouter", id: "@preset/example" }];
				},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "registry-key" };
				},
			},
		});
		const jevConfig = {
			...config,
			classifierModel: "openrouter/typesafe/jev-1.13",
		};
		const result = await defaultClassifyAction(
			ctx,
			jevConfig,
			"git push --force origin main",
			"",
		);
		assert.equal(result.decision, "allow");
		assert.equal(authHeader, "Bearer registry-key");

		// The environment variable wins over the registry key.
		process.env[JEV_API_KEY_ENV] = "env-key";
		await defaultClassifyAction(
			ctx,
			jevConfig,
			"git push --force origin main",
			"",
		);
		assert.equal(authHeader, "Bearer env-key");
	} finally {
		globalThis.fetch = originalFetch;
		if (previous === undefined) delete process.env[JEV_API_KEY_ENV];
		else process.env[JEV_API_KEY_ENV] = previous;
	}
});

test("defaultClassifyAction routes typesafe specs to the native System One API", async () => {
	const previous = process.env[JEV_TYPESAFE_API_KEY_ENV];
	process.env[JEV_TYPESAFE_API_KEY_ENV] = "typesafe-key";
	const originalFetch = globalThis.fetch;
	let fetchedUrl: string | undefined;
	let authHeader: string | undefined;
	const stub: typeof fetch = async (input, init) => {
		fetchedUrl = String(input);
		authHeader = (init?.headers as Record<string, string> | undefined)
			?.authorization;
		return new Response(
			JSON.stringify({
				model: "jev-1.13.0",
				answers: answers({ none: 0.97 }),
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
	};
	globalThis.fetch = stub;
	try {
		const ctx = createFakeCtx([], {
			modelRegistry: {
				find() {
					throw new Error("Jev classification must not use the model registry");
				},
				async getApiKeyAndHeaders() {
					throw new Error("Jev classification must not use the model registry");
				},
			},
		});
		const result = await defaultClassifyAction(
			ctx,
			{ ...config, classifierModel: "typesafe/jev-latest" },
			"rm -rf /",
			"",
		);
		assert.equal(result.decision, "allow");
		assert.equal(fetchedUrl, JEV_TYPESAFE_URL);
		assert.equal(authHeader, "Bearer typesafe-key");
		assert.equal(result.io?.model, "typesafe/jev-latest");
	} finally {
		globalThis.fetch = originalFetch;
		if (previous === undefined) delete process.env[JEV_TYPESAFE_API_KEY_ENV];
		else process.env[JEV_TYPESAFE_API_KEY_ENV] = previous;
	}
});

test("defaultClassifyAction falls back to a registered typesafe provider key", async () => {
	const previous = process.env[JEV_TYPESAFE_API_KEY_ENV];
	delete process.env[JEV_TYPESAFE_API_KEY_ENV];
	const originalFetch = globalThis.fetch;
	let authHeader: string | undefined;
	const stub: typeof fetch = async (_input, init) => {
		authHeader = (init?.headers as Record<string, string> | undefined)
			?.authorization;
		return new Response(
			JSON.stringify({
				model: "jev-1.13.0",
				answers: answers({ none: 0.97 }),
			}),
		);
	};
	globalThis.fetch = stub;
	try {
		const ctx = createFakeCtx([], {
			modelRegistry: {
				find() {
					throw new Error(
						"Jev classification must not resolve the model through the registry",
					);
				},
				getAvailable() {
					return [{ provider: "typesafe", id: "jev-latest" }];
				},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "typesafe-registry-key" };
				},
			},
		});
		const result = await defaultClassifyAction(
			ctx,
			{ ...config, classifierModel: "typesafe/jev-latest" },
			"git push --force origin main",
			"",
		);
		assert.equal(result.decision, "allow");
		assert.equal(authHeader, "Bearer typesafe-registry-key");
	} finally {
		globalThis.fetch = originalFetch;
		if (previous === undefined) delete process.env[JEV_TYPESAFE_API_KEY_ENV];
		else process.env[JEV_TYPESAFE_API_KEY_ENV] = previous;
	}
});
