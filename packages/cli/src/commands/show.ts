import { createGitArtifactStore } from "@f0rbit/runbook-git-store";

const formatError = (error: { kind: string }) => {
	if (error.kind === "ref_not_found") return "Run not found.";
	return `Error: ${JSON.stringify(error)}`;
};

export async function handleShow(args: string[]): Promise<void> {
	const store = createGitArtifactStore();

	const prompt_flag = args.indexOf("--prompt") !== -1;
	const positional = args.filter((a) => !a.startsWith("--"));

	const run_id = positional[0];
	if (!run_id) {
		console.error("Usage: runbook show <run-id> [step-id] [--prompt]");
		process.exit(1);
	}

	const step_id = positional[1];

	if (step_id) {
		const result = await store.getStepArtifacts(run_id, step_id);
		if (!result.ok) {
			console.error(formatError(result.error));
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

	const result = await store.getTrace(run_id);
	if (!result.ok) {
		console.error(formatError(result.error));
		process.exit(1);
	}

	const trace = result.value;
	console.log(`Run: ${trace.run_id}`);
	console.log(`Workflow: ${trace.workflow_id}`);
	console.log(`Status: ${trace.status}`);
	console.log(`Duration: ${(trace.duration_ms / 1000).toFixed(1)}s`);
	console.log(`Events: ${trace.events.length}`);
	console.log("");

	for (const event of trace.events) {
		const ts = new Date(event.timestamp).toISOString().slice(11, 23);
		switch (event.type) {
			case "workflow_start":
				console.log(`  [${ts}] workflow_start  ${event.workflow_id}`);
				break;
			case "workflow_complete":
				console.log(`  [${ts}] workflow_complete  ${(event.duration_ms / 1000).toFixed(1)}s`);
				break;
			case "workflow_error":
				console.log(`  [${ts}] workflow_error  ${event.error.kind}`);
				break;
			case "step_start":
				console.log(`  [${ts}] step_start  ${event.step_id}`);
				break;
			case "step_complete":
				console.log(`  [${ts}] step_complete  ${event.step_id}  ${(event.duration_ms / 1000).toFixed(1)}s`);
				break;
			case "step_error":
				console.log(`  [${ts}] step_error  ${event.step_id}  ${event.error.kind}`);
				break;
			case "step_skipped":
				console.log(`  [${ts}] step_skipped  ${event.step_id}  ${event.reason}`);
				break;
			case "agent_session_created":
				console.log(`  [${ts}] agent_session  ${event.step_id}`);
				break;
			case "agent_prompt_sent":
				console.log(`  [${ts}] agent_prompt  ${event.step_id}`);
				break;
			case "agent_tool_call":
				console.log(`  [${ts}] agent_tool  ${event.step_id}  ${event.call.tool}`);
				break;
			case "agent_tool_result":
				console.log(`  [${ts}] agent_result  ${event.step_id}  ${event.tool}`);
				break;
			case "agent_response":
				console.log(`  [${ts}] agent_response  ${event.step_id}`);
				break;
			case "checkpoint_waiting":
				console.log(`  [${ts}] checkpoint  ${event.step_id}  waiting`);
				break;
			case "checkpoint_resolved":
				console.log(`  [${ts}] checkpoint  ${event.step_id}  resolved`);
				break;
		}
	}
}
