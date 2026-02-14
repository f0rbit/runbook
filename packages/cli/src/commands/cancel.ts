import { createRunbookClient } from "../client";
import { formatError } from "../output";

export async function handleCancel(args: string[], base_url: string): Promise<void> {
	const client = createRunbookClient(base_url);

	let run_id = args[0];

	if (!run_id) {
		const runs_result = await client.listRuns();
		if (!runs_result.ok) {
			console.error(formatError(runs_result.error));
			process.exit(1);
		}
		const running = runs_result.value.find((r) => r.status === "running");
		if (!running) {
			console.log("No running workflows to cancel.");
			return;
		}
		run_id = running.run_id;
	}

	const result = await client.cancelRun(run_id);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(`Cancelled run ${run_id}`);
}
