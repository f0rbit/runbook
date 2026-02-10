import type { Trace, TraceEvent } from "@f0rbit/runbook";
import { createGitArtifactStore } from "@f0rbit/runbook-git-store";

const stepEvents = (events: TraceEvent[]) =>
	events.filter(
		(e): e is Extract<TraceEvent, { type: "step_start" | "step_complete" | "step_error" }> =>
			e.type === "step_start" || e.type === "step_complete" || e.type === "step_error",
	);

const stepSummary = (events: TraceEvent[]) => {
	const steps = stepEvents(events);
	const map = new Map<string, { status: string; duration_ms?: number }>();
	for (const e of steps) {
		if (e.type === "step_start") map.set(e.step_id, { status: "running" });
		if (e.type === "step_complete") map.set(e.step_id, { status: "success", duration_ms: e.duration_ms });
		if (e.type === "step_error") map.set(e.step_id, { status: "error", duration_ms: e.duration_ms });
	}
	return map;
};

const printTrace = (label: string, trace: Trace) => {
	const steps = stepSummary(trace.events);
	console.log(
		`  ${label}: ${trace.status}  ${(trace.duration_ms / 1000).toFixed(1)}s  ${steps.size} steps  ${trace.events.length} events`,
	);
};

export async function handleDiff(args: string[]): Promise<void> {
	const store = createGitArtifactStore();

	const positional = args.filter((a) => !a.startsWith("--"));
	if (positional.length < 2) {
		console.error("Usage: runbook diff <run-id-1> <run-id-2>");
		process.exit(1);
	}

	const [id_a, id_b] = positional;

	const [result_a, result_b] = await Promise.all([store.getTrace(id_a), store.getTrace(id_b)]);

	if (!result_a.ok) {
		console.error(`Run ${id_a} not found.`);
		process.exit(1);
	}
	if (!result_b.ok) {
		console.error(`Run ${id_b} not found.`);
		process.exit(1);
	}

	const trace_a = result_a.value;
	const trace_b = result_b.value;

	console.log("Comparing runs:");
	printTrace(`A (${id_a.slice(0, 8)})`, trace_a);
	printTrace(`B (${id_b.slice(0, 8)})`, trace_b);
	console.log("");

	if (trace_a.status !== trace_b.status) {
		console.log(`  Status: ${trace_a.status} → ${trace_b.status}`);
	}

	const delta_ms = trace_b.duration_ms - trace_a.duration_ms;
	const sign = delta_ms >= 0 ? "+" : "";
	console.log(
		`  Duration: ${(trace_a.duration_ms / 1000).toFixed(1)}s → ${(trace_b.duration_ms / 1000).toFixed(1)}s (${sign}${(delta_ms / 1000).toFixed(1)}s)`,
	);

	const steps_a = stepSummary(trace_a.events);
	const steps_b = stepSummary(trace_b.events);
	const all_steps = new Set([...steps_a.keys(), ...steps_b.keys()]);

	if (steps_a.size !== steps_b.size) {
		console.log(`  Steps: ${steps_a.size} → ${steps_b.size}`);
	}

	console.log("");
	console.log("Step comparison:");

	for (const step_id of all_steps) {
		const a = steps_a.get(step_id);
		const b = steps_b.get(step_id);

		if (!a) {
			console.log(`  + ${step_id}  (added in B)`);
		} else if (!b) {
			console.log(`  - ${step_id}  (removed in B)`);
		} else if (a.status !== b.status) {
			console.log(`  ~ ${step_id}  ${a.status} → ${b.status}`);
		} else if (a.duration_ms !== undefined && b.duration_ms !== undefined) {
			const step_delta = b.duration_ms - a.duration_ms;
			const step_sign = step_delta >= 0 ? "+" : "";
			console.log(
				`  = ${step_id}  ${(a.duration_ms / 1000).toFixed(1)}s → ${(b.duration_ms / 1000).toFixed(1)}s (${step_sign}${(step_delta / 1000).toFixed(1)}s)`,
			);
		} else {
			console.log(`  = ${step_id}  ${a.status}`);
		}
	}
}
