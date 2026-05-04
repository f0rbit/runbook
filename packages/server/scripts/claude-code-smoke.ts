import { query } from "@anthropic-ai/claude-agent-sdk";

const stream = query({
	prompt: "say hi",
	options: {
		cwd: process.cwd(),
		maxTurns: 1,
	},
});

let final_text = "";

for await (const message of stream) {
	if (message.type === "assistant") {
		const blocks = message.message.content as Array<{ type: string; text?: string }>;
		for (const block of blocks) {
			if (block.type === "text" && block.text) process.stdout.write(block.text);
		}
	}
	if (message.type === "result") {
		if (message.subtype === "success") final_text = message.result;
		break;
	}
}

console.log("\n--- final ---");
console.log(final_text);
