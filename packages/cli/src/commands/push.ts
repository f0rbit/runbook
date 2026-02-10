import { createGitArtifactStore } from "@f0rbit/runbook-git-store";

export async function handlePush(args: string[]): Promise<void> {
	const store = createGitArtifactStore();
	const remote_idx = args.indexOf("--remote");
	const remote = remote_idx !== -1 ? args[remote_idx + 1] : undefined;

	const result = await store.push({ remote });
	if (!result.ok) {
		console.error("Push failed:", result.error);
		process.exit(1);
	}
	console.log(`Pushed ${result.value.refs_synced} refs to ${result.value.remote}`);
}
