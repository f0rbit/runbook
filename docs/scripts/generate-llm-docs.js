import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const publicDir = join(dirname(new URL(import.meta.url).pathname), "..", "public");
mkdirSync(publicDir, { recursive: true });

writeFileSync(join(publicDir, "llms.txt"), "");
writeFileSync(join(publicDir, "llms-full.txt"), "");

console.log("Generated stub llms.txt and llms-full.txt");
