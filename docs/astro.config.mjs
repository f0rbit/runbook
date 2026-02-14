import solidJs from "@astrojs/solid-js";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://f0rbit.github.io",
	base: "/runbook",
	integrations: [
		solidJs(),
		starlight({
			title: "@f0rbit/runbook",
			customCss: ["./src/styles/custom.css"],
			components: {
				ThemeSelect: "./src/components/ThemeSelect.astro",
				PageTitle: "./src/components/PageTitle.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
				Footer: "./src/components/Footer.astro",
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/f0rbit/runbook",
				},
			],
			sidebar: [
				{
					label: "Getting Started",
					items: [
						{ label: "Installation", slug: "getting-started/installation" },
						{ label: "Quick Start", slug: "getting-started/quick-start" },
					],
				},
				{
					label: "Concepts",
					items: [
						{ label: "Steps", slug: "concepts/steps" },
						{ label: "Workflows", slug: "concepts/workflows" },
						{ label: "Providers", slug: "concepts/providers" },
						{ label: "Traces", slug: "concepts/traces" },
						{ label: "Configuration", slug: "concepts/configuration" },
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "Testing", slug: "guides/testing" },
						{ label: "Agent Steps", slug: "guides/agent-steps" },
						{ label: "Git Artifact Store", slug: "guides/git-artifact-store" },
						{ label: "Config Files", slug: "guides/config-files" },
					],
				},
				{
					label: "Packages",
					items: [
						{ label: "@f0rbit/runbook", slug: "packages/core" },
						{ label: "@f0rbit/runbook-server", slug: "packages/server" },
						{ label: "@f0rbit/runbook-cli", slug: "packages/cli" },
						{ label: "@f0rbit/runbook-git-store", slug: "packages/git-store" },
					],
				},
				{
					label: "Use Cases",
					items: [
						{ label: "Overview", slug: "use-cases/overview" },
						{ label: "Comparisons", slug: "use-cases/comparisons" },
					],
				},
				{
					label: "Resources",
					items: [{ label: "Architecture", slug: "resources/architecture" }],
				},
			],
		}),
	],
});
