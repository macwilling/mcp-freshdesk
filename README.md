# mcp-freshdesk

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Freshdesk](https://freshdesk.com). Lets Claude (or any MCP client) read tickets, conversations, and add notes.

Runs locally as a stdio subprocess.

## Tools

| Tool | Description |
|---|---|
| `get_ticket` | Fetch a ticket by ID. Optionally includes conversations in one call. |
| `get_ticket_conversations` | All replies, notes, and outgoing emails on a ticket (paginated). |
| `list_tickets` | Recent tickets, newest first. Supports filters and `updated_since`. |
| `search_tickets` | Query using Freshdesk filter syntax, e.g. `status:2 AND priority:4`. |
| `add_note` | Add a note to a ticket. Defaults to private (agents only). |

Responses are slimmed to save context: HTML bodies are stripped in favor of `_text` variants, and attachment payloads are replaced with `has_attachments` / `attachment_count`.

### Slim vs full mode

`get_ticket` and `get_ticket_conversations` accept a `mode` parameter (default `"slim"`). On heavy tickets with dozens of replies, slim mode is what keeps the response from blowing past usable context.

In slim mode:

- **Quoted reply chains and signatures are trimmed** from `body_text` / `description_text`. The trim recognizes Gmail/Apple Mail (`On <date>, <name> wrote:`), Outlook (`-----Original Message-----`, `From:`/`Sent:`/`To:` blocks, underscore dividers), and the RFC 3676 `--` signature delimiter.
- **Routing metadata is dropped** — `to_emails`, `cc_emails`, `bcc_emails`, `support_email`, `source_additional_info`, escalation flags, sentiment scores, and other rarely-needed fields.

Pass `mode: "full"` to bypass both — bodies are returned untrimmed and all metadata is preserved. The tool descriptions instruct the model to retry with full mode automatically when the slim version is missing context (e.g. a reply references text that isn't visible, or the full CC list is needed).

The trim is heuristic. If your team uses an email client that produces a reply marker not in the list above, slim mode may leave the quoted chain intact — falling back to full mode is harmless.

## Setup

### 1. Install

```bash
git clone https://github.com/macwilling/mcp-freshdesk.git
cd mcp-freshdesk
npm install
```

### 2. Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

```
FRESHDESK_DOMAIN=yourcompany.freshdesk.com
FRESHDESK_API_KEY=your_api_key_here
```

Your API key is at **Profile Settings → View API Key** in Freshdesk.

### 3. Register with your MCP client

**Claude Code** (available in every project):

```bash
claude mcp add freshdesk --scope user -- node /absolute/path/to/mcp-freshdesk/index.js
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-freshdesk/index.js"]
    }
  }
}
```

Restart the client. In Claude Code, verify with `/mcp`.

## Freshdesk query reference

Status codes: `2`=Open, `3`=Pending, `4`=Resolved, `5`=Closed
Priority codes: `1`=Low, `2`=Medium, `3`=High, `4`=Urgent

Examples for `search_tickets`:

- `status:2` — all open
- `status:2 AND priority:4` — urgent + open
- `updated_at:>'2026-04-01'` — updated after a date
- `group_id:123` — tickets in a specific group
- `requester_id:456` — tickets from a specific requester

See the [Freshdesk filter docs](https://developers.freshdesk.com/api/#filter_tickets) for the full syntax.

## Safety

- `add_note` defaults `private: true`. Pass `private: false` explicitly to post a customer-visible note.
- This server only exposes read + add-note. It does not expose ticket creation, status changes, replies to customers, or delete operations.

## License

MIT
