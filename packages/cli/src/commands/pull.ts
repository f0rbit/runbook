import { createGitArtifactStore } from "@f0rbit/runbook-git-store";

export async function handlePull(args: string[]): Promise<void> {
	const store = createGitArtifactStore();
	const remote_idx = args.indexOf("--remote");
	const remote = remote_idx !== -1 ? args[remote_idx + 1] : undefined;

	const result = await store.pull({ remote });
	if (!result.ok) {
		console.error("Pull failed:", result.error);
		process.exit(1);
	}
	console.log(`Pulled ${result.value.refs_synced} refs from ${result.value.remote}`);
}
