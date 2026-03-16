# Feature: REST API (Express)

## Purpose
HTTP interface to the analyzer for programmatic access, future GUI consumption,
and direct curl/Postman workflows.

## Endpoints
GET  /health
→ { status: "ok", ts: ISO8601, db: "connected" | "error" }
POST /repos/:owner/:repo/analyze
body: { deep?: boolean }
→ Metrics (200) | { error: string } (500)
GET  /repos/:owner/:repo
→ Metrics (200) | { error: "not found" } (404)
GET  /trending/:language?
→ TrendingRepo[] (200)

## Error handling
Global error middleware maps:
- Unknown errors → 500 { error: message }
- "not found" domain errors → 404
- Validation errors (bad body) → 400

## API contracts + versioning

### Current: unversioned
All routes are at root path. Acceptable for single-consumer CLI/MCP use.

### When GUI is added: version the API
Add /v1/ prefix to all routes. Keep unversioned routes as aliases during
transition. Use a route-level version middleware rather than duplicating handlers.

Versioning trigger: any breaking change to response shape (renamed field,
removed field, type change). Adding fields is non-breaking.

### Response shape stability rules
- Never remove or rename a field without a version bump
- New fields may be added at any time
- Dates are always ISO8601 strings in responses, never Unix timestamps
- Numbers are always numbers, never strings

## Data model impact
Reads from and writes to the metrics table via PrismaAdapter.
/health checks DB connectivity with a lightweight prisma.$queryRaw`SELECT 1`.

## Auth + GitHub OAuth impact
Current: no auth on any endpoint. Acceptable for local/single-user use.
When multi-user or public deployment is needed:
- Add bearer token middleware before all /repos/* routes
- /health stays public
- OAuth flow adds a /auth/github and /auth/callback route (new router, not
  mixed with existing routes)

## GUI readiness
All endpoints return clean JSON with no server-rendered HTML.
CORS is not enabled by default — add cors middleware when a browser client
exists. No session state — API is stateless by design.

## Known limitations
- No request validation (body shape not checked beyond TypeScript types at
  compile time). Fix: add zod schemas at the route level.
- No pagination on /trending — returns all matching rows. Fix: add
  ?limit=N&offset=N query params.
- No auth — any process with network access can trigger analysis.

## Future work
- zod validation on POST body
- Pagination on /trending
- /v1/ prefix + versioning middleware
- CORS middleware (when GUI exists)
- Rate limiting middleware (express-rate-limit) for public deployment
- /auth/github OAuth flow
