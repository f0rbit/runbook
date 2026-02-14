import { createRunbookClient } from "../client";
import { formatError, formatRunStatus } from "../output";

export async function handleStatus(args: string[], base_url: string): Promise<void> {
	const client = createRunbookClient(base_url);
	const run_id = args[0];

	if (!run_id) {
		// No run-id provided — show most recent run
		const runs_result = await client.listRuns();
		if (!runs_result.ok) {
			console.error(formatError(runs_result.error));
			process.exit(1);
		}
		if (runs_result.value.length === 0) {
			console.log("No runs found. Start one with: runbook run <workflow>");
			return;
		}
		console.log(formatRunStatus(runs_result.value[0]));
		return;
	}

	const result = await client.getRunStatus(run_id);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(formatRunStatus(result.value));
}
