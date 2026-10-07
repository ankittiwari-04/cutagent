import { analyze } from "./analyze.js";

const file = process.argv[2];
if (!file) { console.error("usage: npm run analyze -- <video>"); process.exit(1); }
console.log(JSON.stringify(await analyze(file), null, 2));
