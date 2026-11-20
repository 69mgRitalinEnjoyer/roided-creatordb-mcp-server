# Roided MCP

<img src="logo/roided-b-twotone.svg" alt="Roided MCP logo" width="120">

The CreatorDB MCP, but better.

An MCP server for the [CreatorDB V3 API](https://apiv3.creatordb.app) that works like the official one, without filling the model's context with data.

It serves the official server's 48 tools under the same names and inputs. Behind them it adds a workspace: a database on the server where every CreatorDB reply is saved. A small reply goes back to the model as usual. A big one stays in the workspace, and the model gets a short summary, a CSV link and, in apps that support it, a live table for the person to browse.

Status: version 0.1. It runs end to end against a fake CreatorDB in the test suite. It has not yet been run against the live API or inside Claude. See [What is not built yet](#what-is-not-built-yet).

## What it does

- **The official tools, unchanged.** The 48 tools are loaded from the official package, [`@creatordbai/mcp-server`](https://www.npmjs.com/package/@creatordbai/mcp-server). Names, inputs, descriptions and labels are the official ones, so a skill written for the official server keeps working. The one change is that `vet_creators` has no 150-creator limit.
- **No estimates and no approvals.** A request runs as soon as it is made, as on the official server. The reply reports the credits it used.
- **The 50-row line.** A reply of up to 50 rows is sent exactly as the official server would send it. A longer one is saved as a dataset, and the model gets a summary with a 5-row sample and a CSV link. Niche lists, topic lists and usage reports always come back in full, because the model needs to read them.
- **Whole lists in one request.** `pull_list` runs official one-creator calls over a whole list, or pulls every match of a search, and saves the result as a dataset. It starts at once. If it finishes within about two minutes the reply is the summary. Otherwise it keeps running on the server and `pull_status` reports on it.
- **`vet_creators` with no limit.** The official tool checks up to 150 creators per call. Here it takes any number of creators, or every creator in a saved dataset, and asks CreatorDB about 50 at a time. Up to 50 come back in the reply exactly as the official tool sends them. A longer list comes back as a summary, a live table and a file.
- **Work on the server.** `query_dataset` filters, sorts and counts a dataset and returns only the answer. `add_column` fills a new column from a formula. Neither calls CreatorDB.
- **A live table in the chat.** `show_table`, and every finished pull, opens an interactive table built on [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). The table loads its rows straight from the server, 100 at a time, so they never pass through the model.
- **Judging without a model on the server.** `next_batch` hands out creators to judge against a rubric and `submit_verdicts` saves the verdicts. The customer's own Claude does the reading.

## Tools

| Tools | What they do |
|---|---|
| The official 48 | Search, creator lookups, content search, sponsors, niche and topic lists, submissions and usage. See the [official README](https://github.com/CreatorDB/creatordb-mcp-server). |
| `vet_creators` | One of the official 48, changed: checks size, engagement, audience and sponsors for any number of creators, or for every creator in a saved dataset |
| `import_list` | Saves a list of handles as a dataset, from the call or from an uploaded CSV |
| `pull_list`, `pull_status`, `cancel_pull` | Run official calls over a whole list, check on it, stop it |
| `list_datasets`, `describe_dataset`, `query_dataset` | See what is saved, list its columns, filter, sort and count |
| `add_column` | Adds a formula column |
| `show_table` | Opens a dataset as a live table for the person |
| `export_dataset` | Writes a dataset, or a filtered part of it, to a CSV with an expiring link |
| `delete_dataset` | Deletes a dataset for good |
| `next_batch`, `submit_verdicts` | Judge creators against a rubric, a batch at a time |

### Formulas

Filters, sort keys and computed columns use a small formula language. The model never writes SQL. Every name and value in a formula becomes a bound parameter.

```text
totalFollowers > 50000 and contains(bio, "skincare")
country in ("USA", "GBR") and emails is not null
round(reelsPerformanceRecent.views.median / totalFollowers, 3)
if(totalFollowers >= 100000, "macro", "micro")
```

Columns are named as CreatorDB names them. A dot reaches nested data. `row`, `handle` and `followers` work on every platform. The functions are `contains`, `startswith`, `endswith`, `lower`, `upper`, `length`, `round`, `abs`, `floor`, `ceil`, `sqrt`, `ln`, `log10`, `min`, `max`, `number`, `text`, `coalesce` and `if`.

## How it works

```text
Claude ── short request ──▶ MCP endpoint ──▶ gateway ──▶ CreatorDB API
       ◀── short reply ────      │              │
                                 ▼              ▼ every reply saved
Live table ◀── rows, 100 at a time ── workspace (Postgres)
```

- **Gateway.** The official tool code reads CreatorDB's address from one setting, `CREATORDB_API_BASE`. This server points that setting at its own gateway. Every call then waits for a turn, is retried when CreatorDB says to slow down, and has its raw reply and charge saved before the answer goes back.
- **Workspace.** One per API key. Datasets, raw replies, pulls and verdicts live in Postgres. Each row carries its workspace, and row-level security makes Postgres itself refuse rows that belong to another workspace.
- **Pulls.** A pull is split into chunks of 100 creators. Progress is kept in the database, so a restarted server carries on, and a retried chunk reuses the replies it already paid for.
- **Files.** A CSV is written to the server's disk and shared through a signed link that expires after 24 hours.
- **Creator text.** Bios and captions are untrusted. Invisible characters are stripped, and rows shown to the model are wrapped in a block marked as data.

## Run it locally

Node 22 or later is needed. No database setup is needed: without `DATABASE_URL` the server uses an embedded Postgres in `./data`.

```bash
npm install
npm run dev
```

The server listens on `http://localhost:8787`. Setup is the same as for the official server: give Claude the address, and it sends you to a page where you paste your CreatorDB API key.

In Claude Code:

```bash
claude mcp add --transport http roided-mcp http://localhost:8787/mcp
```

Then type `/mcp`, pick `roided-mcp` and sign in. Your browser opens the key page. Paste your key and press Connect.

Claude on the web, on desktop and on mobile connects from Anthropic's servers, so it needs the server at a public HTTPS address. Add that address as a custom connector and the same key page opens.

Turn off the official CreatorDB connector while you use this one. Both servers offer tools with the same names, and the model may call either.

Scripts can skip the page and send the key in an `X-Creatordb-Api-Key` header, as on the official server.

## Configuration

Copy `.env.example` to `.env`, or set these in the environment.

| Setting | Default | What it is |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:PORT` | The server's public address. File links, sign-in and the live table use it. |
| `DATABASE_URL` | empty | Postgres connection string. Empty means the embedded database in `DATA_DIR`. |
| `DATA_DIR` | `./data` | Where the embedded database and result files are kept |
| `TOKEN_SECRET` | generated locally | Seals sign-in codes, encrypts stored API keys and signs file links. Required when `NODE_ENV=production`. |
| `REPLY_ROW_LIMIT` | `50` | A reply with more rows than this becomes a summary and a file |
| `PULL_WAIT_MS` | `110000` | How long `pull_list` holds its call open before reporting progress |
| `CHUNKS_PER_WORKSPACE` | `3` | Chunks of one workspace that run at the same time |
| `CALLS_PER_CHUNK` | `4` | Creators handled at the same time inside one chunk |
| `MAX_SEARCH_RESULTS` | `10000` | The largest search `pull_list` will page through |

`src/config.ts` lists the rest.

## Deploy

The repository includes a `Dockerfile`. On Google Cloud Run with Cloud SQL for PostgreSQL:

1. Create a Postgres database and note its connection string.
2. Deploy the image with `NODE_ENV=production`, `DATABASE_URL`, `TOKEN_SECRET` (a long random value, kept in Secret Manager) and `PUBLIC_URL` (the service's HTTPS address).
3. Set the service to exactly one instance that is always on, with CPU always allocated. See the next section for why.
4. Add `PUBLIC_URL/mcp` to Claude as a custom connector.

The tables and security rules are created on first start.

## What is not built yet

- **One instance only.** Pulls run inside the server process and result files sit on its disk. With more than one instance, or with an instance that is stopped when idle, pulls stall and file links break. A task queue for pulls and cloud storage for files are the next step.
- **`pull_list` makes one CreatorDB request per creator per call**, the same requests the official tools make. For a quick read on a long list, `vet_creators` is much faster: it asks about 50 creators per request.
- **Key encryption uses the server's own secret.** A cloud key service can replace the two functions in `src/auth/workspaces.ts`.
- **Not yet verified against live systems.** The test suite uses a fake CreatorDB, and the live table was checked in a browser with a stand-in host (`npm run preview:table`). Sign-in from Claude, the table inside Claude, and CreatorDB's real rate limits all still need a first run.
- **No retention rules.** `delete_dataset` removes a dataset and its rows. The raw CreatorDB replies behind it stay as the credit record, with no expiry.
- **No spending limit.** Requests run without approval. A whole-list contact pull can spend a lot of credits at once.

## Tests

```bash
npm test
npm run typecheck
```

The tests start the whole server in memory with an embedded Postgres and a fake CreatorDB, so they spend no credits. They cover the official tools' replies, the 50-row line, whole-list pulls, `vet_creators` on long lists and datasets, pausing when credits run out, formulas, judging, sign-in, file links and the separation between workspaces.

## License and credits

MIT. See [LICENSE](LICENSE).

The 48 official tools come from [`@creatordbai/mcp-server`](https://github.com/CreatorDB/creatordb-mcp-server), which is MIT-licensed. The sign-in flow and token sealing in `src/auth` are adapted from the same project.
