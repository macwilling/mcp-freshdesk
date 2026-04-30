import readline from "readline";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const check = green("✓");
const cross = red("✗");

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 6) return "•••";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function ask(question, { defaultValue } = {}) {
  return new Promise((resolveFn) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? dim(` [${defaultValue}]`) : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolveFn((answer || "").trim() || defaultValue || "");
    });
  });
}

function askHidden(question, { defaultValue } = {}) {
  return new Promise((resolveFn) => {
    const stdin = process.stdin;
    const suffix = defaultValue ? dim(` [${maskSecret(defaultValue)}]`) : "";
    process.stdout.write(`${question}${suffix}: `);

    if (!stdin.isTTY || !stdin.setRawMode) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question("", (answer) => {
        rl.close();
        resolveFn((answer || "").trim() || defaultValue || "");
      });
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";

    const finish = (value) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      resolveFn(value);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish((buf.trim() || defaultValue || ""));
        if (ch === "\u0003") {
          stdin.setRawMode(wasRaw);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch.charCodeAt(0) < 32) continue;
        buf += ch;
        process.stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question, { defaultYes = true } = {}) {
  const hint = defaultYes ? dim("[Y/n]") : dim("[y/N]");
  const ans = await ask(`${question} ${hint}`);
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

function header(title) {
  console.log("\n" + bold(title));
}

export async function runInstall({ repoRoot }) {
  console.log(`\n${bold("Freshdesk MCP setup")}`);
  console.log(dim("Hooks Freshdesk up to Claude. Takes about a minute."));

  const envPath = join(repoRoot, ".env");
  let existing = {};
  if (existsSync(envPath)) {
    console.log(`\nFound existing config at ${dim(envPath)}.`);
    const proceed = await confirm("Update it?");
    if (!proceed) {
      console.log("No problem — bailing out. Your config is untouched.");
      return;
    }
    existing = parseEnv(readFileSync(envPath, "utf8"));
  }

  header("Credentials");
  console.log(dim("Your API key lives at Profile Settings → View API Key in Freshdesk."));
  console.log("");

  let domain = await ask("Freshdesk domain", { defaultValue: existing.FRESHDESK_DOMAIN });
  domain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) {
    console.error(`\n${cross} Domain is required. Run me again when you have it.`);
    process.exit(1);
  }

  const apiKey = await askHidden("API key", { defaultValue: existing.FRESHDESK_API_KEY });
  if (!apiKey) {
    console.error(`\n${cross} API key is required. Run me again when you have it.`);
    process.exit(1);
  }

  header("Connecting");
  process.stdout.write(dim("Pinging Freshdesk... "));
  const auth = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  try {
    const res = await fetch(`https://${domain}/api/v2/agents/me`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) {
      console.log(cross);
      console.error(red(`Freshdesk returned ${res.status} ${res.statusText}.`));
      if (res.status === 401) {
        console.error(dim("→ Double-check your API key, and that it's enabled for your account."));
      } else if (res.status === 404) {
        console.error(dim("→ Double-check the domain — the subdomain in your URL might differ from the one Freshdesk uses for the API."));
      } else {
        const body = await res.text();
        if (body) console.error(dim(body));
      }
      process.exit(1);
    }
    const me = await res.json();
    const who = me?.contact?.name || me?.contact?.email || "agent";
    console.log(`${check} Connected as ${cyan(who)}.`);
  } catch (e) {
    console.log(cross);
    console.error(red(`Network error: ${e.message}`));
    console.error(dim("→ Check that the domain is reachable from this machine."));
    process.exit(1);
  }

  header("Saving config");
  const envContent = `FRESHDESK_DOMAIN=${domain}\nFRESHDESK_API_KEY=${apiKey}\n`;
  writeFileSync(envPath, envContent, { mode: 0o600 });
  console.log(`${check} Wrote ${dim(envPath)} ${dim("(owner-only read)")}.`);

  header("Registering with Claude Code");
  const indexPath = join(repoRoot, "index.js");
  const claudeAvailable = spawnSync("which", ["claude"], { stdio: "ignore" }).status === 0;
  let registered = false;

  if (claudeAvailable) {
    const reg = await confirm("Register the server now?");
    if (reg) {
      const result = spawnSync(
        "claude",
        ["mcp", "add", "freshdesk", "--scope", "user", "--", "node", indexPath],
        { encoding: "utf8" }
      );
      const out = `${result.stdout || ""}${result.stderr || ""}`;
      if (result.status === 0) {
        console.log(`${check} Registered.`);
        registered = true;
      } else if (/already exists/i.test(out)) {
        console.log(`${check} Already registered — your updated credentials will be picked up on next launch.`);
        registered = true;
      } else {
        console.log(cross);
        console.error(red(out.trim() || "claude mcp add failed."));
        console.error(dim(`→ Run manually: claude mcp add freshdesk --scope user -- node ${indexPath}`));
      }
    } else {
      console.log(dim("Skipped. To register later:"));
      console.log(dim(`  claude mcp add freshdesk --scope user -- node ${indexPath}`));
    }
  } else {
    console.log(dim("Claude Code CLI not found on PATH. To register manually:"));
    console.log(dim(`  claude mcp add freshdesk --scope user -- node ${indexPath}`));
  }

  console.log(`\n${dim("For Claude Desktop, add this to claude_desktop_config.json:")}`);
  console.log(
    dim(
      JSON.stringify(
        { mcpServers: { freshdesk: { command: "node", args: [indexPath] } } },
        null,
        2
      )
    )
  );

  console.log(`\n${bold("All set.")}${registered ? " Restart Claude Code and run /mcp to verify." : ""}`);
  console.log(dim('Try: "list my open Freshdesk tickets" or "show me ticket 12345".\n'));
}
