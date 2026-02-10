import { createRunbookClient } from "../client";
import { formatError, formatTrace } from "../output";

export async function handleRun(args: string[], base_url: string): Promise<void> {
	const workflow_id = args[0];
	if (!workflow_id) {
		console.error("Usage: runbook run <workflow> [task description...] [--input <json>]");
		process.exit(1);
	}

	const input_idx = args.indexOf("--input");
	let input: unknown = {};

	if (input_idx !== -1 && args[input_idx + 1]) {
		try {
			input = JSON.parse(args[input_idx + 1]);
		} catch {
			console.error("Invalid JSON input");
			process.exit(1);
		}
	} else {
		const positional: string[] = [];
		for (let i = 1; i < args.length; i++) {
			if (args[i].startsWith("--")) {
				i++;
				continue;
			}
			positional.push(args[i]);
		}
		if (positional.length > 0) {
			input = { task: positional.join(" ") };
		}
	}

	const client = createRunbookClient(base_url);
	const result = await client.submitRun(workflow_id, input);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	console.log(`Run started: ${result.value.run_id}`);

	let status: string = "running";
	while (status === "running" || status === "pending") {
		await Bun.sleep(500);
		const status_result = await client.getRunStatus(result.value.run_id);
		if (!status_result.ok) break;
		status = status_result.value.status;
	}

	const trace_result = await client.getRunTrace(result.value.run_id);
	if (trace_result.ok) {
		console.log(formatTrace(trace_result.value));
	}
}
