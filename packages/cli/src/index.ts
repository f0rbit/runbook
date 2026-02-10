#!/usr/bin/env bun

import { handleDiff } from "./commands/diff";
import { handleHistory } from "./commands/history";
import { handleList } from "./commands/list";
import { handlePull } from "./commands/pull";
import { handlePush } from "./commands/push";
import { handleRun } from "./commands/run";
import { handleServe } from "./commands/serve";
import { handleShow } from "./commands/show";
import { handleStatus } from "./commands/status";
import { handleTrace } from "./commands/trace";

const DEFAULT_URL = "http://localhost:4400";

function getBaseUrl(args: string[]): string {
	const url_idx = args.indexOf("--url");
	if (url_idx !== -1 && args[url_idx + 1]) return args[url_idx + 1];
	return process.env.RUNBOOK_URL ?? DEFAULT_URL;
}

function printHelp() {
	console.log(`Usage: runbook <command> [options]

Commands:
  serve                        Start the runbook server
  run <workflow> [--input json] Submit a workflow run
  status <run-id>              Get run status
  trace <run-id>               Display run trace
  list                         List available workflows
  history                      List stored runs from git
  show <run-id> [step-id]      Show run or step artifacts
  diff <run-id-1> <run-id-2>   Diff two stored runs
  push [--remote origin]       Push artifact refs to remote
  pull [--remote origin]       Pull artifact refs from remote

Options:
  --url <url>                  Server URL (default: http://localhost:4400)
  --config <path>              Config file path
  --help                       Show this help
`);
}

const args = process.argv.slice(2);
const [cmd, ...rest] = args;

switch (cmd) {
	case "serve":
		await handleServe(rest);
		break;
	case "run":
		await handleRun(rest, getBaseUrl(args));
		break;
	case "status":
		await handleStatus(rest, getBaseUrl(args));
		break;
	case "trace":
		await handleTrace(rest, getBaseUrl(args));
		break;
	case "list":
		await handleList(rest, getBaseUrl(args));
		break;
	case "history":
		await handleHistory(rest);
		break;
	case "show":
		await handleShow(rest);
		break;
	case "diff":
		await handleDiff(rest);
		break;
	case "push":
		await handlePush(rest);
		break;
	case "pull":
		await handlePull(rest);
		break;
	case "--help":
	case "-h":
	case undefined:
		printHelp();
		break;
	default:
		console.error(`Unknown command: ${cmd}`);
		printHelp();
		process.exit(1);
}
