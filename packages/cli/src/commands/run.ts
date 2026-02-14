import { createRunbookClient } from "../client";
import { formatError, formatRunStatus, formatStepEvent } from "../output";

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

	// Poll with live event streaming + checkpoint handling
	let status: string = "running";
	let seen_events = 0;
	const resolved_checkpoints = new Set<string>();

	while (status === "running" || status === "pending") {
		await Bun.sleep(500);
		const status_result = await client.getRunStatus(result.value.run_id);
		if (!status_result.ok) break;
		status = status_result.value.status;

		// Print new trace events as they arrive
		const trace_result = await client.getRunTrace(result.value.run_id);
		if (trace_result.ok) {
			const events = trace_result.value.events;
			for (let i = seen_events; i < events.length; i++) {
				const formatted = formatStepEvent(events[i]);
				if (formatted) console.log(formatted);
			}
			seen_events = events.length;
		}

		// Check for pending checkpoints
		const pending = status_result.value.pending_checkpoints ?? [];
		for (const checkpoint_id of pending) {
			if (resolved_checkpoints.has(checkpoint_id)) continue;
			resolved_checkpoints.add(checkpoint_id);

			// Find the checkpoint_waiting event to get the prompt
			let checkpoint_prompt = "Checkpoint requires approval.";
			if (trace_result?.ok) {
				const waiting_event = trace_result.value.events.find((e) => e.type === "checkpoint_waiting");
				if (waiting_event && waiting_event.type === "checkpoint_waiting") {
					checkpoint_prompt = waiting_event.prompt;
				}
			}

			// Display checkpoint prompt and ask for input
			console.log("");
			console.log("\x1b[33m━━━ Checkpoint ━━━\x1b[0m");
			console.log(checkpoint_prompt);
			console.log("");

			const approved = await promptUser("Approve? [y/n]: ");
			const is_approved = approved.toLowerCase().startsWith("y");

			let notes: string | undefined;
			if (!is_approved) {
				notes = await promptUser("Rejection notes (optional): ");
			}

			const resolve_result = await client.resolveCheckpoint(result.value.run_id, checkpoint_id, {
				approved: is_approved,
				notes: notes || undefined,
			});
			if (!resolve_result.ok) {
				console.error("Failed to resolve checkpoint:", formatError(resolve_result.error));
			} else {
				console.log(is_approved ? "\x1b[32m✓ Approved\x1b[0m" : "\x1b[31m✗ Rejected\x1b[0m");
			}
			console.log("\x1b[33m━━━━━━━━━━━━━━━━━━\x1b[0m");
			console.log("");
		}
	}

	// Fetch final status
	const final_status = await client.getRunStatus(result.value.run_id);

	if (final_status.ok && final_status.value.status === "failure") {
		console.log(formatRunStatus(final_status.value));
		if (final_status.value.error) {
			console.error(`\n${formatError(final_status.value.error)}`);
		}
		const trace_result = await client.getRunTrace(result.value.run_id);
		if (trace_result.ok && trace_result.value.events.length > seen_events) {
			for (let i = seen_events; i < trace_result.value.events.length; i++) {
				const formatted = formatStepEvent(trace_result.value.events[i]);
				if (formatted) console.log(formatted);
			}
		}
		process.exit(1);
	}

	// Success — print any remaining events + summary
	const trace_result = await client.getRunTrace(result.value.run_id);
	if (trace_result.ok) {
		for (let i = seen_events; i < trace_result.value.events.length; i++) {
			const formatted = formatStepEvent(trace_result.value.events[i]);
			if (formatted) console.log(formatted);
		}
	}
}

async function promptUser(question: string): Promise<string> {
	process.stdout.write(question);
	return new Promise<string>((resolve) => {
		let data = "";
		const onData = (chunk: Buffer) => {
			data += chunk.toString();
			if (data.includes("\n")) {
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
				resolve(data.trim());
			}
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}
