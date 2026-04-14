# U (Open Memory Infrastructure)

U is a user-owned memory system for agents.

Core idea:
- Data collection happens from user devices (extension/mobile/web) via a Collector API.
- AI access happens through an open MCP server, so users can connect any AI client.
- U is not a closed chat app. It is a context layer that any AI can use.

## Services

1. `@u/collector-api`
- Receives user-captured data from device surfaces.
- Enqueues ingestion jobs for async processing.
- Writes into Postgres + pgvector.

2. `@u/ingestion-worker`
- Claims pending jobs from the database queue.
- Processes ingestion pipeline (fetch/parse/summarize/embed/store).
- Handles retries and terminal failure status.

3. `@u/mcp-server`
- Exposes read/context tools over MCP Streamable HTTP.
- Returns semantic + graph context to any compatible AI client.
- Does not own primary ingestion.

## Current APIs and tools

Collector API endpoints:
- `POST /v1/users`
- `POST /v1/device-keys`
- `POST /v1/collect/url`
- `POST /v1/collect/note`
- `GET /v1/jobs/:jobId`

Collector auth:
- Admin key: `x-u-api-key`
- Device key (preferred for capture clients): `x-u-device-key`

MCP tools:
- `u_search_cards`
- `u_graph_neighbors`
- `u_get_context_bundle`

## Quick start

1. Start Postgres:
   - `docker compose up -d`
2. Install dependencies:
   - `pnpm install`
3. Set environment:
   - `cp .env.example .env`
   - Fill `OPENAI_API_KEY` and `U_COLLECTOR_API_KEY`
4. Prepare database:
   - `pnpm db:generate`
   - `pnpm db:push`
   - `pnpm db:seed`
5. Start both services:
   - `pnpm dev`

## Device capture flow

1. Extension/mobile app captures user data.
2. Client sends payload to Collector API with `x-u-api-key`.
3. Collector responds with `jobId` and accepted status.
4. Ingestion worker processes the job and writes cards + embeddings.
5. Client checks `/v1/jobs/:jobId` for completion.
6. Any AI client connects to U MCP and requests context.

## MCP endpoint

- MCP Streamable HTTP route: `/mcp`
- Health: `/health`

## Notes

- No placeholder storage or mocked retrieval path.
- Data is portable and open via MCP contract.
- Architecture is designed for multi-client AI interoperability.

## Overall Product Tracker

Completed:
- Collector API with async ingestion jobs
- Ingestion worker with retry policy
- Per-device key auth for collector and MCP
- MCP Streamable HTTP context tools
- MCP session-user binding and audit logs
- Idempotent ingestion submit endpoints

Remaining:
- Browser extension capture client (MV3)
- Mobile capture client (basic flow)
- OAuth-based auth (replace shared admin key for production)
- Connection extraction pipeline (auto graph linking)
- Background re-embedding and stale-content refresh jobs
- MCP rate limiting and quota enforcement
- End-to-end tests (collector -> worker -> MCP context)
- Deployment stack (managed Postgres, secrets, monitoring, alerting)
