import { createRunbookClient } from "../client";
import { formatError, formatTrace } from "../output";

export async function handleTrace(args: string[], base_url: string): Promise<void> {
	const run_id = args[0];
	if (!run_id) {
		console.error("Usage: runbook trace <run-id>");
		process.exit(1);
	}

	const client = createRunbookClient(base_url);
	const result = await client.getRunTrace(run_id);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(formatTrace(result.value));
}
