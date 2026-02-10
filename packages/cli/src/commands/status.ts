import { createRunbookClient } from "../client";
import { formatError, formatRunStatus } from "../output";

export async function handleStatus(args: string[], base_url: string): Promise<void> {
	const run_id = args[0];
	if (!run_id) {
		console.error("Usage: runbook status <run-id>");
		process.exit(1);
	}

	const client = createRunbookClient(base_url);
	const result = await client.getRunStatus(run_id);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(formatRunStatus(result.value));
}
