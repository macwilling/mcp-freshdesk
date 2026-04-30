import readline from "readline";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

function prompt(question, { defaultValue } = {}) {
  return new Promise((resolveFn) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` [${maskIfSecret(question, defaultValue)}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolveFn(answer.trim() || defaultValue || "");
    });
  });
}

function maskIfSecret(question, value) {
  if (/key|secret|token|password/i.test(question)) {
    if (value.length <= 6) return "***";
    return `${value.slice(0, 3)}…${value.slice(-3)}`;
  }
  return value;
}

async function confirm(question, { defaultYes = true } = {}) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = await prompt(`${question} ${hint}`);
  if (!ans) return defaultYes;
  return /^y(es)?$/i.test(ans);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function runInstall({ repoRoot }) {
  console.log("\nFreshdesk MCP setup\n");

  const envPath = join(repoRoot, ".env");
  let existing = {};
  if (existsSync(envPath)) {
    console.log(`Existing .env found at ${envPath}.`);
    const proceed = await confirm("Update it?");
    if (!proceed) {
      console.log("Aborted.");
      return;
    }
    existing = parseEnv(readFileSync(envPath, "utf8"));
  }

  let domain = await prompt("Freshdesk domain (e.g. yourcompany.freshdesk.com)", {
    defaultValue: existing.FRESHDESK_DOMAIN,
  });
  domain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) {
    console.error("Domain is required.");
    process.exit(1);
  }

  const apiKey = await prompt("API key (Profile Settings → View API Key)", {
    defaultValue: existing.FRESHDESK_API_KEY,
  });
  if (!apiKey) {
    console.error("API key is required.");
    process.exit(1);
  }

  process.stdout.write("\nValidating credentials... ");
  const auth = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  try {
    const res = await fetch(`https://${domain}/api/v2/agents/me`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) {
      console.log("failed.");
      console.error(`Freshdesk returned ${res.status} ${res.statusText}.`);
      const body = await res.text();
      if (body) console.error(body);
      process.exit(1);
    }
    const me = await res.json();
    const who = me?.contact?.name || me?.contact?.email || "agent";
    console.log(`ok (authenticated as ${who}).`);
  } catch (e) {
    console.log("failed.");
    console.error(`Network error: ${e.message}`);
    console.error("Check that the domain is reachable from this machine.");
    process.exit(1);
  }

  const envContent = `FRESHDESK_DOMAIN=${domain}\nFRESHDESK_API_KEY=${apiKey}\n`;
  writeFileSync(envPath, envContent, { mode: 0o600 });
  console.log(`Wrote ${envPath}`);

  const indexPath = join(repoRoot, "index.js");
  const claudeAvailable = spawnSync("which", ["claude"], { stdio: "ignore" }).status === 0;

  if (claudeAvailable) {
    const reg = await confirm("\nRegister with Claude Code now?");
    if (reg) {
      const result = spawnSync(
        "claude",
        ["mcp", "add", "freshdesk", "--scope", "user", "--", "node", indexPath],
        { stdio: "inherit" }
      );
      if (result.status !== 0) {
        console.error("\nRegistration failed. You can run it manually:");
        console.error(`  claude mcp add freshdesk --scope user -- node ${indexPath}`);
      } else {
        console.log("\nRegistered with Claude Code. Restart it, then run /mcp to verify.");
      }
    } else {
      console.log("\nSkipped. To register later:");
      console.log(`  claude mcp add freshdesk --scope user -- node ${indexPath}`);
    }
  } else {
    console.log("\nClaude Code CLI not found on PATH. To register manually:");
    console.log(`  claude mcp add freshdesk --scope user -- node ${indexPath}`);
  }

  console.log("\nFor Claude Desktop, add this to claude_desktop_config.json:");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          freshdesk: {
            command: "node",
            args: [indexPath],
          },
        },
      },
      null,
      2
    )
  );
  console.log("\nDone.");
}
