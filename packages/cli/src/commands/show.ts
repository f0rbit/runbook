import type { Trace } from "@f0rbit/runbook";
import { createGitArtifactStore } from "@f0rbit/runbook-git-store";
import { createRunbookClient } from "../client";
import { formatStepEvent } from "../output";

const formatGitError = (error: { kind: string }) => {
	if (error.kind === "ref_not_found") return null;
	return `Error: ${JSON.stringify(error)}`;
};

export async function handleShow(args: string[], base_url: string): Promise<void> {
	const store = createGitArtifactStore();

	const prompt_flag = args.indexOf("--prompt") !== -1;
	const positional = args.filter((a) => !a.startsWith("--"));

	const run_id = positional[0];
	if (!run_id) {
		console.error("Usage: runbook show <run-id> [step-id] [--prompt]");
		process.exit(1);
	}

	const step_id = positional[1];

	// --- Step artifacts (git-store only for now) ---
	if (step_id) {
		const result = await store.getStepArtifacts(run_id, step_id);
		if (!result.ok) {
			const msg = formatGitError(result.error);
			console.error(msg ?? "Run not found in git store. Step artifacts are only available for archived runs.");
			process.exit(1);
		}

		if (prompt_flag) {
			if (!result.value.prompt) {
				console.log("No prompt stored for this step.");
				return;
			}
			console.log(result.value.prompt);
			return;
		}

		console.log(`Step: ${result.value.step_id}`);
		if (result.value.input !== undefined) {
			console.log("\nInput:");
			console.log(JSON.stringify(result.value.input, null, 2));
		}
		if (result.value.output !== undefined) {
			console.log("\nOutput:");
			console.log(JSON.stringify(result.value.output, null, 2));
		}
		if (result.value.prompt) {
			console.log("\nPrompt:");
			console.log(result.value.prompt);
		}
		if (result.value.response) {
			console.log("\nResponse:");
			console.log(JSON.stringify(result.value.response, null, 2));
		}
		if (result.value.iterations?.length) {
			console.log(`\nIterations: ${result.value.iterations.length}`);
		}
		return;
	}

	// --- Run overview: try git-store first, fall back to server ---

	const git_result = await store.getTrace(run_id);
	if (git_result.ok) {
		printTrace(git_result.value);
		return;
	}

	// Git-store miss — try server API
	const hard_error = formatGitError(git_result.error);
	if (hard_error) {
		// Non-ref_not_found error from git-store — still try server
	}

	const client = createRunbookClient(base_url);
	const status_result = await client.getRunStatus(run_id);
	if (!status_result.ok) {
		console.error("Run not found.");
		process.exit(1);
	}

	const trace_result = await client.getRunTrace(run_id);
	if (!trace_result.ok) {
		const run = status_result.value;
		console.log(`Run: ${run.run_id}`);
		console.log(`Workflow: ${run.workflow_id}`);
		console.log(`Status: ${run.status}`);
		console.log(`Started: ${run.started_at}`);
		return;
	}

	printTrace(trace_result.value);
}

function printTrace(trace: Trace) {
	console.log(`Run: ${trace.run_id}`);
	console.log(`Workflow: ${trace.workflow_id}`);
	console.log(`Status: ${trace.status}`);
	console.log(`Duration: ${(trace.duration_ms / 1000).toFixed(1)}s`);
	console.log(`Events: ${trace.events.length}`);
	console.log("");

	for (const event of trace.events) {
		const formatted = formatStepEvent(event);
		if (formatted) console.log(formatted);
	}
}
