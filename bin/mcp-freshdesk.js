#!/usr/bin/env node
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const cmd = process.argv[2];

function printHelp() {
  console.log(`mcp-freshdesk

Usage:
  mcp-freshdesk             Run the MCP server (default; what MCP clients invoke)
  mcp-freshdesk install     Interactive setup — credentials, validation, and Claude Code registration
  mcp-freshdesk help        Show this message
`);
}

if (cmd === "install") {
  const { runInstall } = await import("./install.js");
  await runInstall({ repoRoot });
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
} else if (!cmd || cmd === "start") {
  await import(resolve(repoRoot, "index.js"));
} else {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}
