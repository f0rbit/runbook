import { createGitArtifactStore } from "@f0rbit/runbook-git-store";

export async function handleHistory(args: string[]): Promise<void> {
	const store = createGitArtifactStore();

	const wf_idx = args.indexOf("--workflow");
	const workflow_id = wf_idx !== -1 ? args[wf_idx + 1] : undefined;
	const limit_idx = args.indexOf("--limit");
	const limit = limit_idx !== -1 ? parseInt(args[limit_idx + 1], 10) : undefined;

	const result = await store.list({ workflow_id, limit });
	if (!result.ok) {
		console.error("Error:", result.error);
		process.exit(1);
	}

	if (result.value.length === 0) {
		console.log("No stored runs found.");
		return;
	}

	console.log("Stored runs:");
	for (const run of result.value) {
		const status_icon = run.status === "success" ? "✓" : "✗";
		const duration = (run.duration_ms / 1000).toFixed(1);
		console.log(
			`  ${status_icon} ${run.run_id.slice(0, 8)}  ${run.workflow_id}  ${duration}s  ${run.started_at.toISOString()}`,
		);
	}
}
