import type { Result } from "@f0rbit/corpus";
import { err, ok } from "@f0rbit/corpus";
import type { GitStoreError } from "./types";

declare const Bun: {
	spawn(
		cmd: string[],
		opts?: {
			cwd?: string;
			stdin?: "pipe" | "inherit" | "ignore" | ReadableStream<Uint8Array>;
			stdout?: "pipe" | "inherit" | "ignore";
			stderr?: "pipe" | "inherit" | "ignore";
		},
	): {
		readonly stdin: WritableStream<Uint8Array>;
		readonly stdout: ReadableStream<Uint8Array>;
		readonly stderr: ReadableStream<Uint8Array>;
		readonly exited: Promise<number>;
		kill(): void;
	};
};

type TreeEntry = { mode: string; type: string; hash: string; name: string };

const run = async (args: string[], cwd?: string, stdin_data?: string): Promise<Result<string, GitStoreError>> => {
	const cmd = ["git", ...args];
	const proc = Bun.spawn(cmd, {
		cwd,
		stdin: stdin_data ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (stdin_data) {
		const writer = proc.stdin.getWriter();
		await writer.write(new TextEncoder().encode(stdin_data));
		await writer.close();
	}

	const exit_code = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (exit_code !== 0) {
		return err({ kind: "git_command_failed", command: cmd.join(" "), stderr: stderr.trim(), exit_code });
	}

	return ok(stdout.trim());
};

export const hashObject = (content: string, cwd?: string): Promise<Result<string, GitStoreError>> =>
	run(["hash-object", "-w", "--stdin"], cwd, content);

export const mkTree = (entries: TreeEntry[], cwd?: string): Promise<Result<string, GitStoreError>> => {
	const input = entries.map((e) => `${e.mode} ${e.type} ${e.hash}\t${e.name}`).join("\n");
	return run(["mktree"], cwd, input);
};

export const updateRef = (ref: string, sha: string, cwd?: string): Promise<Result<string, GitStoreError>> =>
	run(["update-ref", ref, sha], cwd);

export const forEachRef = async (
	pattern: string,
	format: string,
	cwd?: string,
): Promise<Result<string[], GitStoreError>> => {
	const result = await run(["for-each-ref", `--format=${format}`, pattern], cwd);
	if (!result.ok) return result;
	return ok(result.value === "" ? [] : result.value.split("\n"));
};

export const catFile = (ref: string, path: string, cwd?: string): Promise<Result<string, GitStoreError>> =>
	run(["cat-file", "-p", `${ref}:${path}`], cwd);

export const isGitRepo = async (cwd?: string): Promise<boolean> => {
	const result = await run(["rev-parse", "--git-dir"], cwd);
	return result.ok;
};

export const pushRefs = (remote: string, refspec: string, cwd?: string): Promise<Result<string, GitStoreError>> =>
	run(["push", remote, refspec], cwd);

export const fetchRefs = (remote: string, refspec: string, cwd?: string): Promise<Result<string, GitStoreError>> =>
	run(["fetch", remote, refspec], cwd);
