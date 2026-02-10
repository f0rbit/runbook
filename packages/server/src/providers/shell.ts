import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { ShellError, ShellOpts, ShellProvider, ShellResult } from "./types";

declare const Bun: {
	spawn(
		cmd: string[],
		opts?: {
			cwd?: string;
			env?: Record<string, string | undefined>;
			stdout?: "pipe" | "inherit" | "ignore";
			stderr?: "pipe" | "inherit" | "ignore";
		},
	): {
		readonly stdout: ReadableStream<Uint8Array>;
		readonly stderr: ReadableStream<Uint8Array>;
		readonly exited: Promise<number>;
		kill(): void;
	};
};

declare const process: { env: Record<string, string | undefined> };

export class BunShellProvider implements ShellProvider {
	async exec(command: string, opts?: ShellOpts): Promise<Result<ShellResult, ShellError>> {
		try {
			const proc = Bun.spawn(["sh", "-c", command], {
				cwd: opts?.cwd,
				env: opts?.env ? { ...process.env, ...opts.env } : undefined,
				stdout: "pipe",
				stderr: "pipe",
			});

			let timed_out = false;
			let timeout_id: ReturnType<typeof setTimeout> | undefined;

			if (opts?.timeout_ms) {
				timeout_id = setTimeout(() => {
					timed_out = true;
					proc.kill();
				}, opts.timeout_ms);
			}

			if (opts?.signal) {
				opts.signal.addEventListener("abort", () => proc.kill(), { once: true });
			}

			const exit_code = await proc.exited;
			if (timeout_id) clearTimeout(timeout_id);

			if (timed_out) {
				return err({ kind: "shell_spawn_error", command, cause: `Timed out after ${opts?.timeout_ms}ms` });
			}

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();

			return ok({ stdout, stderr, exit_code });
		} catch (e) {
			return err({
				kind: "shell_spawn_error",
				command,
				cause: e instanceof Error ? e.message : String(e),
			});
		}
	}
}
