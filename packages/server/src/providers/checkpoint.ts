import type { Result } from "@f0rbit/corpus";
import { ok } from "@f0rbit/corpus";
import type { CheckpointError, CheckpointProvider, PendingCheckpoint } from "@f0rbit/runbook";
import type { z } from "zod";

export type PendingCheckpointRegistry = {
	register: (checkpoint_id: string, checkpoint: PendingCheckpoint) => void;
};

export function createServerCheckpointProvider(
	registry: PendingCheckpointRegistry,
	step_id: string,
): CheckpointProvider {
	return {
		async prompt(message: string, schema: z.ZodType): Promise<Result<unknown, CheckpointError>> {
			const checkpoint_id = crypto.randomUUID();

			return new Promise<Result<unknown, CheckpointError>>((outer_resolve) => {
				registry.register(checkpoint_id, {
					step_id,
					schema,
					resolve: (value) => outer_resolve(ok(value)),
					reject: (error) => outer_resolve({ ok: false, error }),
				});
			});
		},
	};
}
