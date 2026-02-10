import type { Trace, TraceEmitter, TraceEvent } from "./types";

export class TraceCollector implements TraceEmitter {
	events: TraceEvent[] = [];
	private listeners: ((event: TraceEvent) => void)[] = [];

	emit(event: TraceEvent): void {
		this.events.push(event);
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	onEvent(listener: (event: TraceEvent) => void): void {
		this.listeners.push(listener);
	}

	toTrace(run_id: string, workflow_id: string, status: "success" | "failure", duration_ms: number): Trace {
		return {
			run_id,
			workflow_id,
			events: [...this.events],
			status,
			duration_ms,
		};
	}
}
