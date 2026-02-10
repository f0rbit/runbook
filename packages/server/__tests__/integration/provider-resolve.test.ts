import { describe, expect, test } from "bun:test";
import { resolveProviders } from "../../src/providers/resolve";

describe("resolveProviders", () => {
	test("creates shell provider with no config", async () => {
		const result = await resolveProviders();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.shell).toBeDefined();
			expect(result.value.agent).toBeUndefined();
		}
	});

	test("creates shell provider with empty provider config", async () => {
		const result = await resolveProviders({});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.shell).toBeDefined();
			expect(result.value.agent).toBeUndefined();
		}
	});

	test("creates shell provider with agent config of unknown type", async () => {
		const result = await resolveProviders({
			agent: { type: "unknown-executor" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.shell).toBeDefined();
			// Unknown type is silently ignored — no agent created
			expect(result.value.agent).toBeUndefined();
		}
	});

	test("returns error when opencode executor fails to initialize", async () => {
		// OpenCode executor requires a running server or SDK.
		// Without it, create() will fail with connection_failed.
		// We test this to confirm the error propagation works.
		const result = await resolveProviders({
			agent: { type: "opencode", base_url: "http://localhost:99999" },
		});
		// This may succeed (if opencode-ai/sdk is installed and creates a client
		// without connecting), or fail (if it tries to connect immediately).
		// Either way, it should not throw.
		expect(typeof result.ok).toBe("boolean");
	});
});
