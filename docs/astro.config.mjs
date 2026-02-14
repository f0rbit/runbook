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
			sidebar: [],
		}),
	],
});
