import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { RunbookConfig } from "@f0rbit/runbook";

export type ConfigError =
	| { kind: "config_not_found"; searched: string[] }
	| { kind: "config_load_error"; path: string; cause: string };

export async function loadConfig(explicit_path?: string): Promise<Result<RunbookConfig, ConfigError>> {
	if (explicit_path) {
		const abs = resolve(explicit_path);
		if (!existsSync(abs)) {
			return err({ kind: "config_not_found", searched: [abs] });
		}
		return importConfig(abs);
	}

	const searched: string[] = [];
	let dir = process.cwd();

	while (true) {
		const candidate = join(dir, "runbook.config.ts");
		searched.push(candidate);

		if (existsSync(candidate)) {
			return importConfig(candidate);
		}

		const pkg_path = join(dir, "package.json");
		if (existsSync(pkg_path)) {
			try {
				const pkg = await import(pkg_path);
				if (pkg.default?.private === true || pkg.private === true) {
					break;
				}
			} catch {
				// ignore unreadable package.json
			}
		}

		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return err({ kind: "config_not_found", searched });
}

async function importConfig(path: string): Promise<Result<RunbookConfig, ConfigError>> {
	try {
		const mod = await import(path);
		const config = mod.default ?? mod;
		return ok(config as RunbookConfig);
	} catch (e) {
		return err({
			kind: "config_load_error",
			path,
			cause: e instanceof Error ? e.message : String(e),
		});
	}
}
