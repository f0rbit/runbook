import type { ClientError, StepError, Trace, TraceEvent, WorkflowError } from "@f0rbit/runbook";
import type { RunInfo, WorkflowInfo } from "./client";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string): string {
	switch (status) {
		case "success":
			return GREEN;
		case "failure":
			return RED;
		case "running":
			return YELLOW;
		case "cancelled":
			return YELLOW;
		default:
			return GRAY;
	}
}

function statusIcon(status: string): string {
	switch (status) {
		case "success":
			return `${GREEN}✓${RESET}`;
		case "failure":
			return `${RED}✗${RESET}`;
		case "running":
			return `${YELLOW}⟳${RESET}`;
		case "cancelled":
			return `${YELLOW}⊘${RESET}`;
		default:
			return `${GRAY}○${RESET}`;
	}
}

export function formatWorkflowList(workflows: WorkflowInfo[]): string {
	if (workflows.length === 0) return `${DIM}No workflows found.${RESET}`;

	const max_id_len = Math.max(...workflows.map((w) => w.id.length));
	const rows = workflows
		.map((w) => {
			const padded = w.id.padEnd(max_id_len + 2);
			return `  ${CYAN}${padded}${RESET}${DIM}${w.step_count} step${w.step_count === 1 ? "" : "s"}${RESET}`;
		})
		.join("\n");

	return `${BOLD}Workflows:${RESET}\n${rows}`;
}

export function formatRunStatus(run: RunInfo): string {
	const color = statusColor(run.status);
	const icon = statusIcon(run.status);
	const short_id = run.run_id.slice(0, 8);

	const lines = [
		`${BOLD}Run ${short_id}${RESET}`,
		`  Workflow: ${CYAN}${run.workflow_id}${RESET}`,
		`  Status:   ${color}${run.status}${RESET} ${icon}`,
		`  Started:  ${DIM}${run.started_at}${RESET}`,
	];

	if (run.completed_at && run.started_at) {
		const started = new Date(run.started_at).getTime();
		const completed = new Date(run.completed_at).getTime();
		const duration_ms = completed - started;
		if (!Number.isNaN(duration_ms) && duration_ms >= 0) {
			lines.push(`  Duration: ${formatDuration(duration_ms)}`);
		}
	}

	if (run.error) {
		lines.push(`  Error:    ${formatError(run.error)}`);
	}

	return lines.join("\n");
}

export function formatTrace(trace: Trace): string {
	const short_id = trace.run_id.slice(0, 8);
	const header = `${BOLD}▸ ${trace.workflow_id}${RESET} ${DIM}[run:${short_id}]${RESET}`;

	const lines: string[] = [header];
	for (const event of trace.events) {
		const formatted = formatStepEvent(event);
		if (formatted) lines.push(formatted);
	}

	return lines.join("\n");
}

type StepSummary = {
	step_id: string;
	status: "complete" | "error" | "skipped";
	duration_ms: number;
	error_cause?: string;
};

function buildStepSummaries(events: TraceEvent[]): StepSummary[] {
	const summaries: StepSummary[] = [];
	const seen = new Set<string>();

	for (const event of events) {
		if (event.type === "step_complete" && !seen.has(event.step_id)) {
			seen.add(event.step_id);
			summaries.push({ step_id: event.step_id, status: "complete", duration_ms: event.duration_ms });
		} else if (event.type === "step_error" && !seen.has(event.step_id)) {
			seen.add(event.step_id);
			summaries.push({
				step_id: event.step_id,
				status: "error",
				duration_ms: event.duration_ms,
				error_cause: formatStepErrorBrief(event.error),
			});
		} else if (event.type === "step_skipped" && !seen.has(event.step_id)) {
			seen.add(event.step_id);
			summaries.push({ step_id: event.step_id, status: "skipped", duration_ms: 0 });
		}
	}

	return summaries;
}

function formatStepError(error: StepError): string {
	switch (error.kind) {
		case "validation_error":
			return `validation: ${error.issues.map((i) => i.message).join(", ")}`;
		case "execution_error":
			return error.cause;
		case "timeout":
			return `timeout after ${formatDuration(error.timeout_ms)}`;
		case "aborted":
			return "aborted";
		case "shell_error":
			return `exit ${error.code}: ${error.stderr.slice(0, 80)}`;
		case "agent_error":
			return error.cause;
		case "agent_parse_error": {
			const issues_text =
				error.issues.length > 0
					? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
					: "no valid JSON found in response";
			const raw_preview = error.raw_output ? `\n    response (first 200 chars): ${error.raw_output.slice(0, 200)}` : "";
			return `parse error: ${issues_text}${raw_preview}`;
		}
		case "checkpoint_rejected":
			return "checkpoint rejected";
	}
}

function formatStepErrorBrief(error: StepError): string {
	switch (error.kind) {
		case "agent_parse_error":
			return error.issues.length > 0
				? `parse error: ${error.issues.map((i) => i.message).join(", ")}`
				: "parse error: no valid JSON in response";
		default:
			return formatStepError(error).split("\n")[0];
	}
}

export function formatError(error: unknown): string {
	if (error && typeof error === "object" && "kind" in error) {
		const e = error as { kind: string };

		// ClientError
		if (e.kind === "http_error") {
			const ce = error as ClientError & { kind: "http_error" };
			return `${RED}HTTP ${ce.status}${RESET}: ${ce.body}`;
		}
		if (e.kind === "connection_refused") {
			const ce = error as ClientError & { kind: "connection_refused" };
			return `${RED}Connection refused${RESET}: ${ce.url}\n  ${DIM}${ce.cause}${RESET}`;
		}
		if (e.kind === "parse_error") {
			const ce = error as ClientError & { kind: "parse_error" };
			return `${RED}Parse error${RESET}: ${ce.cause}`;
		}

		// WorkflowError
		if (e.kind === "step_failed") {
			const we = error as WorkflowError & { kind: "step_failed" };
			return `${RED}Step failed${RESET}: ${we.step_id}\n  ${formatStepError(we.error)}`;
		}
		if (e.kind === "invalid_workflow") {
			const we = error as WorkflowError & { kind: "invalid_workflow" };
			return `${RED}Invalid workflow${RESET}:\n${we.issues.map((i) => `  - ${i}`).join("\n")}`;
		}
		if (e.kind === "config_error") {
			const we = error as WorkflowError & { kind: "config_error" };
			return `${RED}Config error${RESET}: ${we.message}`;
		}

		return `${RED}${e.kind}${RESET}: ${JSON.stringify(error)}`;
	}

	if (error instanceof Error) {
		return `${RED}${error.name}${RESET}: ${error.message}`;
	}

	return `${RED}Error${RESET}: ${String(error)}`;
}

export function formatStepEvent(event: TraceEvent): string | null {
	switch (event.type) {
		case "workflow_start":
			return `${BOLD}▸ ${event.workflow_id}${RESET} ${DIM}[run:${event.run_id.slice(0, 8)}]${RESET} starting...`;
		case "workflow_complete":
			return `${GREEN}✓${RESET} ${BOLD}${event.workflow_id}${RESET} completed in ${formatDuration(event.duration_ms)}`;
		case "workflow_error":
			return `${RED}✗${RESET} ${BOLD}${event.workflow_id}${RESET} failed after ${formatDuration(event.duration_ms)}`;
		case "step_start":
			return `  ${YELLOW}⟳${RESET} ${event.step_id}`;
		case "step_complete":
			return `  ${GREEN}✓${RESET} ${event.step_id.padEnd(20)} ${DIM}${formatDuration(event.duration_ms)}${RESET}`;
		case "step_error":
			return `  ${RED}✗${RESET} ${event.step_id.padEnd(20)} ${DIM}${formatDuration(event.duration_ms)}${RESET}  ${RED}${formatStepErrorBrief(event.error)}${RESET}`;
		case "step_skipped":
			return `  ${GRAY}⊘ ${event.step_id}${RESET} ${DIM}skipped: ${event.reason}${RESET}`;
		case "checkpoint_waiting":
			return `  ${YELLOW}⏸${RESET} ${event.step_id} waiting: ${event.prompt}`;
		case "checkpoint_resolved":
			return `  ${GREEN}▶${RESET} ${event.step_id} checkpoint resolved`;
		case "agent_session_created":
			return `    ${DIM}session ${event.session.id.slice(0, 12)}${RESET}`;
		case "agent_prompt_sent": {
			const preview = event.text.replace(/\n/g, " ").slice(0, 120);
			return `    ${CYAN}→${RESET} ${DIM}${preview}${event.text.length > 120 ? "..." : ""}${RESET}`;
		}
		case "agent_text": {
			const text = event.text.trim();
			if (!text) return null;
			const max_len = 500;
			const truncated = text.length > max_len ? text.slice(0, max_len) + "..." : text;
			const indented = truncated
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n");
			return `    ${CYAN}▍${RESET}\n${indented}`;
		}
		case "agent_tool_call":
			return null;
		case "agent_tool_result":
			return null;
		case "agent_response": {
			const meta = event.response.metadata;
			const tool_count = meta.tool_calls?.length ?? 0;
			const tool_info = tool_count > 0 ? ` (${tool_count} tool calls)` : "";
			return `    ${DIM}completed in ${formatDuration(meta.duration_ms)}${tool_info}${RESET}`;
		}
	}
}
