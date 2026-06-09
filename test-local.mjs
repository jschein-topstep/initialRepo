import fs from "fs";
import { handler } from "./index.mjs";

const file = process.argv[2] || "sample-event.json";
const event = JSON.parse(fs.readFileSync(file, "utf8"));
const result = await handler(event);
console.log(result.body);
