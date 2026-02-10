import { createRunbookClient } from "../client";
import { formatError, formatWorkflowList } from "../output";

export async function handleList(_args: string[], base_url: string): Promise<void> {
	const client = createRunbookClient(base_url);
	const result = await client.listWorkflows();
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(formatWorkflowList(result.value));
}
