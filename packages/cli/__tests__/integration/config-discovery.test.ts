import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";

describe("config discovery", () => {
	test("explicit --config path takes precedence", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "runbook-cfg-"));
		const config_path = join(tmp, "runbook.config.ts");
		writeFileSync(config_path, "export default { workflows: [] };");

		const result = await loadConfig(config_path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.workflows).toEqual([]);
		}
	});

	test("explicit path returns error when file missing", async () => {
		const result = await loadConfig("/tmp/nonexistent-runbook-config-12345.ts");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("config_not_found");
		}
	});

	test("global fallback includes ~/.config/runbook/runbook.config.ts in searched paths", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "runbook-cfg-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ private: true }));

		const original_cwd = process.cwd();
		process.chdir(tmp);
		try {
			const result = await loadConfig();
			const global_config = join(homedir(), ".config", "runbook", "runbook.config.ts");
			const global_exists = existsSync(global_config);

			if (global_exists) {
				// Global config found — should succeed
				expect(result.ok).toBe(true);
			} else {
				// No global config — should fail with config_not_found
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.kind).toBe("config_not_found");
					if (result.error.kind === "config_not_found") {
						// The global path should be in the searched list
						expect(result.error.searched).toContain(global_config);
					}
				}
			}
		} finally {
			process.chdir(original_cwd);
		}
	});

	test("local config takes precedence over global", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "runbook-cfg-"));
		writeFileSync(join(tmp, "runbook.config.ts"), "export default { workflows: [], server: { port: 9999 } };");

		const original_cwd = process.cwd();
		process.chdir(tmp);
		try {
			const result = await loadConfig();
			expect(result.ok).toBe(true);
			if (result.ok) {
				// If we got the local config, it has port 9999
				expect(result.value.server?.port).toBe(9999);
			}
		} finally {
			process.chdir(original_cwd);
		}
	});
});
