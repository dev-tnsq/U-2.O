# U (MCP-first)

U is a second-brain platform built MCP-first so agents can ingest, search, and reason over your full context.

## What exists now
- Real Postgres data model via Prisma
- MCP stdio server with tools:
  - `u_create_user`
  - `u_ingest_url`
  - `u_create_note`
  - `u_search_cards`
  - `u_graph_neighbors`
  - `u_get_context_bundle`
- OpenAI-backed summarization + embeddings
- Vector storage in pgvector

## Quick start
1. Start Postgres:
   - `docker compose up -d`
2. Install dependencies:
   - `pnpm install`
3. Set environment:
   - `cp .env.example .env`
   - Fill `OPENAI_API_KEY`
4. Prepare database:
   - `pnpm db:generate`
   - `pnpm db:push`
   - `pnpm db:seed`
5. Run MCP server:
   - `pnpm dev`

## MCP usage
Configure your MCP client to launch:
- command: `pnpm`
- args: `["--filter", "@u/mcp-server", "dev"]`
- cwd: repository root

## Notes
- This is intentionally MCP-first, no web UI required.
- All reads/writes go through real Postgres and real model APIs.
