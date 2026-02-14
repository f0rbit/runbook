import { createRunbookClient } from "../client";
import { formatError, formatRunStatus, formatStepEvent } from "../output";

export async function handleStatus(args: string[], base_url: string): Promise<void> {
	const client = createRunbookClient(base_url);

	const live = args.includes("--live");
	const filtered_args = args.filter((a) => a !== "--live");
	const run_id = filtered_args[0];

	if (!run_id && !live) {
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

	// Resolve run ID (use latest if not provided)
	let resolved_id = run_id;
	if (!resolved_id) {
		const runs_result = await client.listRuns();
		if (!runs_result.ok) {
			console.error(formatError(runs_result.error));
			process.exit(1);
		}
		if (runs_result.value.length === 0) {
			console.log("No runs found. Start one with: runbook run <workflow>");
			return;
		}
		resolved_id = runs_result.value[0].run_id;
	}

	if (!live) {
		const result = await client.getRunStatus(resolved_id);
		if (!result.ok) {
			console.error(formatError(result.error));
			process.exit(1);
		}
		console.log(formatRunStatus(result.value));

		const trace_result = await client.getRunTrace(resolved_id);
		if (trace_result.ok && trace_result.value.events.length > 0) {
			console.log("");
			for (const event of trace_result.value.events) {
				const formatted = formatStepEvent(event);
				if (formatted) console.log(formatted);
			}
		}
		return;
	}

	// Live mode: poll like handleRun does
	let status = "running";
	let seen_events = 0;

	while (status === "running" || status === "pending") {
		const status_result = await client.getRunStatus(resolved_id);
		if (!status_result.ok) break;
		status = status_result.value.status;

		const trace_result = await client.getRunTrace(resolved_id);
		if (trace_result.ok) {
			const events = trace_result.value.events;
			for (let i = seen_events; i < events.length; i++) {
				const formatted = formatStepEvent(events[i]);
				if (formatted) console.log(formatted);
			}
			seen_events = events.length;
		}

		if (status === "running" || status === "pending") {
			await Bun.sleep(500);
		}
	}

	// Print final status
	const final = await client.getRunStatus(resolved_id);
	if (final.ok) {
		console.log(formatRunStatus(final.value));
	}
}
