import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const docsDir = join(scriptDir, "..");
const repoRoot = join(docsDir, "..");
const publicDir = join(docsDir, "public");
const contentDocsDir = join(docsDir, "src", "content", "docs");

// --- Helpers ---

function stripFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return content;
	return content.slice(match[0].length);
}

function extractTitle(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const frontmatter = match[1];
	for (const line of frontmatter.split("\n")) {
		const titleMatch = line.match(/^title:\s*["']?(.+?)["']?\s*$/);
		if (titleMatch) return titleMatch[1];
	}
	return null;
}

function readMdxFilesRecursive(dir) {
	const results = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...readMdxFilesRecursive(fullPath));
		} else if (entry.name.endsWith(".mdx")) {
			results.push(fullPath);
		}
	}
	return results;
}

const SECTION_ORDER = ["index.mdx", "getting-started", "concepts", "guides", "packages", "use-cases", "resources"];

function sectionSortKey(relPath) {
	if (relPath === "index.mdx") return [0, relPath];
	const section = relPath.split("/")[0];
	const idx = SECTION_ORDER.indexOf(section);
	return [idx === -1 ? 999 : idx, relPath];
}

function compareMdxPaths(a, b) {
	const [aIdx, aPath] = sectionSortKey(a);
	const [bIdx, bPath] = sectionSortKey(b);
	if (aIdx !== bIdx) return aIdx - bIdx;
	return aPath.localeCompare(bPath);
}

function readPackageExports() {
	const packages = [
		{ name: "@f0rbit/runbook", dir: "core" },
		{ name: "@f0rbit/runbook-server", dir: "server" },
		{ name: "@f0rbit/runbook-cli", dir: "cli" },
		{ name: "@f0rbit/runbook-git-store", dir: "git-store" },
	];
	return packages
		.map(({ name, dir }) => {
			const indexPath = join(repoRoot, "packages", dir, "src", "index.ts");
			if (!existsSync(indexPath)) return null;
			const content = readFileSync(indexPath, "utf-8");
			return { name, dir, content };
		})
		.filter(Boolean);
}

// --- Read inputs ---

const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
const usecase = readFileSync(join(repoRoot, "USECASE.md"), "utf-8");
const packageExports = readPackageExports();

const mdxFiles = readMdxFilesRecursive(contentDocsDir);
const mdxRelPaths = mdxFiles.map((f) => relative(contentDocsDir, f));
mdxRelPaths.sort(compareMdxPaths);

const mdxEntries = mdxRelPaths.map((relPath) => {
	const fullPath = join(contentDocsDir, relPath);
	const raw = readFileSync(fullPath, "utf-8");
	const title = extractTitle(raw) || relPath;
	const body = stripFrontmatter(raw).trim();
	return { relPath, title, body };
});

// --- CLI help text ---

const CLI_HELP = `Usage: runbook <command> [options]

Commands:
  serve                        Start the runbook server
  run <workflow> [task...] [--input json] Submit a workflow run
  status [run-id] [--live]     Get run status (--live to stream events)
  trace <run-id>               Display run trace
  list                         List available workflows
  history                      List stored runs from git
  show <run-id> [step-id]      Show run or step artifacts
  diff <run-id-1> <run-id-2>   Diff two stored runs
  push [--remote origin]       Push artifact refs to remote
  cancel [run-id]              Cancel a running workflow
  pull [--remote origin]       Pull artifact refs from remote

Options:
  --url <url>                  Server URL (default: http://localhost:4400)
  --config <path>              Config file path
  --help                       Show this help`;

// --- Generate llms.txt (concise) ---

const llmsTxt = `# @f0rbit/runbook

> Typed workflow engine for orchestrating AI agents, shell commands, and human checkpoints with compile-time safety.

## Installation

bun add @f0rbit/runbook @f0rbit/runbook-server zod @f0rbit/corpus

## Core Concepts

- **4 step types**: fn() (pure functions), shell() (shell commands), agent() (AI agents), checkpoint() (human approval)
- **Typed pipelines**: defineWorkflow() → .pipe() → .parallel() → .done() with compile-time type checking via Zod schemas
- **Provider pattern**: ShellProvider, AgentExecutor, CheckpointProvider — swappable implementations for production and testing
- **Structured traces**: 14 typed event types covering workflow lifecycle, step execution, agent sessions, and checkpoints

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| core | @f0rbit/runbook | SDK: types, step builders, workflow builder, trace types |
| server | @f0rbit/runbook-server | Hono HTTP server: engine, providers, routes, state |
| cli | @f0rbit/runbook-cli | Thin CLI client: HTTP client, command handlers, config |
| git-store | @f0rbit/runbook-git-store | Git-based artifact store for workflow traces |

## CLI Commands

serve                        Start the runbook server
run <workflow> [task...] [--input json] Submit a workflow run
status [run-id] [--live]     Get run status (--live to stream events)
trace <run-id>               Display run trace
list                         List available workflows
history                      List stored runs from git
show <run-id> [step-id]      Show run or step artifacts
diff <run-id-1> <run-id-2>   Diff two stored runs
push [--remote origin]       Push artifact refs to remote
cancel [run-id]              Cancel a running workflow
pull [--remote origin]       Pull artifact refs from remote

## Links

- Full documentation: https://f0rbit.github.io/runbook/
- Comprehensive LLM docs: https://f0rbit.github.io/runbook/llms-full.txt
- GitHub: https://github.com/f0rbit/runbook
`;

// --- Generate llms-full.txt (comprehensive) ---

const packageApiSections = packageExports
	.map(({ name, dir, content }) => `## ${name} (packages/${dir})\n\n\`\`\`typescript\n${content.trim()}\n\`\`\``)
	.join("\n\n");

const docSections = mdxEntries
	.map(({ relPath, title, body }) => `## ${title} (${relPath})\n\n${body}`)
	.join("\n\n---\n\n");

const llmsFullTxt = `# @f0rbit/runbook — Full Documentation for LLMs

> Typed workflow engine for orchestrating AI agents, shell commands, and human checkpoints with compile-time safety.

---

# README

${readme.trim()}

---

# Use Cases

${usecase.trim()}

---

# Package API Reference

${packageApiSections}

---

# CLI Command Reference

\`\`\`
${CLI_HELP}
\`\`\`

---

# Documentation

${docSections}

---

# Links

- Documentation: https://f0rbit.github.io/runbook/
- GitHub: https://github.com/f0rbit/runbook
- Concise version: https://f0rbit.github.io/runbook/llms.txt
`;

// --- Write outputs ---

mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "llms.txt"), llmsTxt);
writeFileSync(join(publicDir, "llms-full.txt"), llmsFullTxt);

console.log(`Generated llms.txt (${llmsTxt.length} bytes) and llms-full.txt (${llmsFullTxt.length} bytes)`);
