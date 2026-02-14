import { createRunbookClient } from "../client";
import { formatError, formatRunStatus, formatStepEvent } from "../output";

export async function handleResume(args: string[], base_url: string): Promise<void> {
	const run_id = args[0];
	if (!run_id) {
		console.error("Usage: runbook resume <run-id>");
		process.exit(1);
	}

	const client = createRunbookClient(base_url);

	const status_result = await client.getRunStatus(run_id);
	if (!status_result.ok) {
		console.error(formatError(status_result.error));
		process.exit(1);
	}

	const existing_run = status_result.value;
	console.log(`Resuming run ${run_id} (workflow: ${existing_run.workflow_id})`);

	const resume_result = await client.resumeRun(existing_run.workflow_id, run_id);
	if (!resume_result.ok) {
		console.error(formatError(resume_result.error));
		process.exit(1);
	}

	const new_run_id = resume_result.value.run_id;
	console.log(`Resumed as new run: ${new_run_id}`);

	let status: string = "running";
	let seen_events = 0;
	const resolved_checkpoints = new Set<string>();

	while (status === "running" || status === "pending") {
		await Bun.sleep(500);
		const poll = await client.getRunStatus(new_run_id);
		if (!poll.ok) break;
		status = poll.value.status;

		const trace_result = await client.getRunTrace(new_run_id);
		if (trace_result.ok) {
			const events = trace_result.value.events;
			for (let i = seen_events; i < events.length; i++) {
				const formatted = formatStepEvent(events[i]);
				if (formatted) console.log(formatted);
			}
			seen_events = events.length;
		}

		const pending = poll.value.pending_checkpoints ?? [];
		for (const checkpoint_id of pending) {
			if (resolved_checkpoints.has(checkpoint_id)) continue;
			resolved_checkpoints.add(checkpoint_id);

			let checkpoint_prompt = "Checkpoint requires approval.";
			if (trace_result?.ok) {
				const waiting_event = trace_result.value.events.find((e) => e.type === "checkpoint_waiting");
				if (waiting_event && waiting_event.type === "checkpoint_waiting") {
					checkpoint_prompt = waiting_event.prompt;
				}
			}

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

			const resolve_result = await client.resolveCheckpoint(new_run_id, checkpoint_id, {
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

	const final_status = await client.getRunStatus(new_run_id);

	if (final_status.ok && final_status.value.status === "failure") {
		console.log(formatRunStatus(final_status.value));
		if (final_status.value.error) {
			console.error(`\n${formatError(final_status.value.error)}`);
		}
		const trace_result = await client.getRunTrace(new_run_id);
		if (trace_result.ok && trace_result.value.events.length > seen_events) {
			for (let i = seen_events; i < trace_result.value.events.length; i++) {
				const formatted = formatStepEvent(trace_result.value.events[i]);
				if (formatted) console.log(formatted);
			}
		}
		process.exit(1);
	}

	const trace_result = await client.getRunTrace(new_run_id);
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
