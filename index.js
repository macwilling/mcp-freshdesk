import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, ".env") });

const DOMAIN = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;

if (!DOMAIN || !API_KEY) {
  console.error(
    "Missing FRESHDESK_DOMAIN or FRESHDESK_API_KEY. Copy .env.example to .env and fill both."
  );
  process.exit(1);
}

const BASE_URL = `https://${DOMAIN}/api/v2`;
const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:X`).toString("base64")}`;

async function freshdesk(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data?.description
        ? `${data.description}${data.errors ? ": " + JSON.stringify(data.errors) : ""}`
        : text || res.statusText;
    throw new Error(`Freshdesk ${method} ${path} → ${res.status}: ${msg}`);
  }

  return data;
}

// Trim quoted reply chains, forwarded message blocks, and signature delimiters
// from plain-text email bodies. Heuristic — falls back to the original text if
// no marker is found. Use mode="full" upstream when this might over-trim.
function stripQuotedReply(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.split(/\r?\n/);
  let cutAt = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Gmail/Apple Mail: "On <date>, <name> wrote:" (single line)
    if (/^On\b.{1,300}\bwrote:\s*$/.test(trimmed)) {
      cutAt = i;
      break;
    }
    // Same, split across two lines: "On <date>...\n<name> wrote:"
    if (/^On\b.{1,300}$/.test(trimmed) && i + 1 < lines.length) {
      if (/wrote:\s*$/.test(lines[i + 1].trim())) {
        cutAt = i;
        break;
      }
    }
    // Outlook: "-----Original Message-----"
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(trimmed)) {
      cutAt = i;
      break;
    }
    // Outlook divider line of underscores
    if (/^_{10,}\s*$/.test(trimmed)) {
      cutAt = i;
      break;
    }
    // Outlook header block: "From: ..." followed by Sent/Date/To within 4 lines
    if (/^From:\s/i.test(trimmed)) {
      const lookahead = lines.slice(i + 1, i + 5).join("\n");
      if (/^(Sent|Date|To):\s/im.test(lookahead)) {
        cutAt = i;
        break;
      }
    }
    // RFC 3676 signature delimiter
    if (trimmed === "--") {
      cutAt = i;
      break;
    }
  }

  return lines.slice(0, cutAt).join("\n").trimEnd();
}

function slimTicket(t, { mode = "slim" } = {}) {
  if (!t) return t;
  const {
    description, // keep description_text instead
    attachments,
    custom_fields,
    description_text,
    ...rest
  } = t;
  const base = {
    ...rest,
    description_text:
      mode === "full" ? description_text : stripQuotedReply(description_text),
    has_attachments: Array.isArray(attachments) && attachments.length > 0,
    attachment_count: Array.isArray(attachments) ? attachments.length : 0,
    custom_fields: custom_fields && Object.keys(custom_fields).length ? custom_fields : undefined,
  };
  if (mode === "full") return base;

  // Slim mode: drop routing/metadata noise that is rarely needed for understanding the ticket.
  const {
    to_emails,
    cc_emails,
    bcc_emails,
    fwd_emails,
    reply_cc_emails,
    support_email,
    source_additional_info,
    email_config_id,
    product_id,
    internal_agent_id,
    internal_group_id,
    nr_due_by,
    nr_escalated,
    fr_escalated,
    is_escalated,
    sentiment_score,
    initial_sentiment_score,
    association_type,
    associated_tickets_list,
    ...slimmed
  } = base;
  return slimmed;
}

function slimConversation(c, { mode = "slim" } = {}) {
  if (!c) return c;
  const { body, attachments, body_text, ...rest } = c;
  const base = {
    ...rest,
    body_text: mode === "full" ? body_text : stripQuotedReply(body_text),
    has_attachments: Array.isArray(attachments) && attachments.length > 0,
    attachment_count: Array.isArray(attachments) ? attachments.length : 0,
  };
  if (mode === "full") return base;

  // Slim mode: keep only fields that matter for following the conversation.
  const {
    id,
    user_id,
    from_email,
    private: isPrivate,
    incoming,
    source,
    category,
    ticket_id,
    created_at,
    updated_at,
  } = base;
  return {
    id,
    user_id,
    from_email,
    private: isPrivate,
    incoming,
    source,
    category,
    ticket_id,
    created_at,
    ...(updated_at && updated_at !== created_at ? { updated_at } : {}),
    body_text: base.body_text,
    has_attachments: base.has_attachments,
    attachment_count: base.attachment_count,
  };
}

function asText(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({
  name: "freshdesk",
  version: "0.1.0",
});

const MODE_GUIDANCE =
  "Defaults to 'slim': drops routing metadata (cc/bcc/support_email/etc.) and trims quoted reply chains and signatures from message bodies to keep context small. If the slim version is hard to follow — e.g. a reply seems to reference text you can't see, you need the full CC list, or the thread doesn't make sense — retry the same call with mode='full' to get untrimmed bodies and all metadata.";

server.registerTool(
  "get_ticket",
  {
    title: "Get Freshdesk ticket",
    description:
      "Fetch a single ticket by ID. By default also pulls requester, stats, and company. Set include_conversations=true to also fetch all comments/emails in one call. " +
      MODE_GUIDANCE,
    inputSchema: {
      ticket_id: z.number().int().describe("Freshdesk ticket ID"),
      include_conversations: z
        .boolean()
        .optional()
        .describe("Also fetch conversations (comments + emails). Default false."),
      mode: z
        .enum(["slim", "full"])
        .optional()
        .describe("'slim' (default) trims metadata and quoted reply chains. 'full' returns everything — use as a fallback when slim drops context you need."),
    },
  },
  async ({ ticket_id, include_conversations, mode }) => {
    const m = mode ?? "slim";
    const ticket = await freshdesk(`/tickets/${ticket_id}`, {
      query: { include: "requester,stats,company" },
    });
    const result = { ticket: slimTicket(ticket, { mode: m }) };
    if (include_conversations) {
      const convos = await freshdesk(`/tickets/${ticket_id}/conversations`);
      result.conversations = Array.isArray(convos)
        ? convos.map((c) => slimConversation(c, { mode: m }))
        : convos;
    }
    return asText(result);
  }
);

server.registerTool(
  "get_ticket_conversations",
  {
    title: "Get ticket conversations",
    description:
      "Fetch all conversations (customer replies, agent replies, public/private notes, outgoing emails) for a ticket. Paginated — use page for tickets with >30 items. " +
      MODE_GUIDANCE,
    inputSchema: {
      ticket_id: z.number().int().describe("Freshdesk ticket ID"),
      page: z.number().int().optional().describe("1-based page (default 1, 30 per page)"),
      mode: z
        .enum(["slim", "full"])
        .optional()
        .describe("'slim' (default) trims metadata and quoted reply chains. 'full' returns everything — use as a fallback when slim drops context you need."),
    },
  },
  async ({ ticket_id, page, mode }) => {
    const m = mode ?? "slim";
    const convos = await freshdesk(`/tickets/${ticket_id}/conversations`, {
      query: { page },
    });
    return asText(
      Array.isArray(convos) ? convos.map((c) => slimConversation(c, { mode: m })) : convos
    );
  }
);

server.registerTool(
  "list_tickets",
  {
    title: "List Freshdesk tickets",
    description:
      "List tickets, newest first. Optional filter: 'new_and_my_open', 'watching', 'spam', 'deleted'. Optional updated_since ISO8601 to only return tickets updated after that time.",
    inputSchema: {
      filter: z
        .enum(["new_and_my_open", "watching", "spam", "deleted"])
        .optional(),
      updated_since: z
        .string()
        .optional()
        .describe("ISO8601 timestamp, e.g. 2026-04-20T00:00:00Z"),
      page: z.number().int().optional().describe("1-based page, 30 per page"),
      per_page: z.number().int().max(100).optional().describe("Up to 100"),
    },
  },
  async ({ filter, updated_since, page, per_page }) => {
    const tickets = await freshdesk(`/tickets`, {
      query: { filter, updated_since, page, per_page, order_by: "updated_at", order_type: "desc" },
    });
    return asText(Array.isArray(tickets) ? tickets.map(slimTicket) : tickets);
  }
);

server.registerTool(
  "search_tickets",
  {
    title: "Search Freshdesk tickets",
    description:
      'Search tickets using Freshdesk query syntax. Example queries: "status:2" (open), "priority:4 AND status:2" (urgent open), "updated_at:>\'2026-04-01\'", "group_id:123". Status: 2=Open, 3=Pending, 4=Resolved, 5=Closed. Priority: 1=Low, 2=Medium, 3=High, 4=Urgent. Wrap the whole query in double quotes per Freshdesk docs.',
    inputSchema: {
      query: z
        .string()
        .describe('Freshdesk filter query, e.g. status:2 AND priority:4'),
      page: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ query, page }) => {
    const wrapped = `"${query.replace(/"/g, '\\"')}"`;
    const result = await freshdesk(`/search/tickets`, {
      query: { query: wrapped, page },
    });
    const results = result?.results;
    return asText({
      total: result?.total,
      count: Array.isArray(results) ? results.length : 0,
      tickets: Array.isArray(results) ? results.map(slimTicket) : results,
    });
  }
);

server.registerTool(
  "add_note",
  {
    title: "Add note to ticket",
    description:
      "Add a note (comment) to a ticket. Defaults to private (agents only). Set private=false for a public note visible to the requester.",
    inputSchema: {
      ticket_id: z.number().int(),
      body: z.string().describe("Note body. Plain text or simple HTML."),
      private: z.boolean().optional().describe("Default true (agents only)"),
    },
  },
  async ({ ticket_id, body, private: isPrivate }) => {
    const note = await freshdesk(`/tickets/${ticket_id}/notes`, {
      method: "POST",
      body: { body, private: isPrivate ?? true },
    });
    return asText(slimConversation(note));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
