# DVB-I Application Provider and Admin Portal + Receiver — Deployment & Operations

Two apps:
- **rt-dvb-i-application-provider** (this project, "DVB-I Application Provider and Admin Portal"): generates the DVB-I
  service list and TV-Anytime EPG; provides the authoring UI.
- **rt-dvb-i-application**: browser player that loads and renders a service list.

## Running

```
cd rt-dvb-i-application-provider && npm install && npm start      # http://localhost:4000
cd rt-dvb-i-application && npm install && npm start    # http://localhost:5000
```

Published service list: `GET /service-list.xml` (public).
EPG: `GET /epg/schedule?sid=<uid>&start=<unixtime>&end=<unixtime>` or `&now_next=true|window`,
`GET /epg/program?pid=<crid>` (ETSI TS 103 770 V1.2.1 clauses 6.5 and 6.6).

## Admin authentication (IMPORTANT)

The admin API is gated by an optional bearer token.

- **Unset (default):** no authentication. Fine for a laptop/dev machine only.
- **Set `ADMIN_TOKEN`:** all config/mutating/proxy routes require `Authorization: Bearer <token>`.

```
ADMIN_TOKEN="$(openssl rand -hex 24)" npm start
```

Gated routes: `GET/PUT /api/config`, `POST/DELETE /api/logos/upload/:id`, `GET /api/history`,
`POST /api/history/restore/:filename`, `GET /api/xml`, `GET /api/test-url`, `GET /api/fetch-xml`.
Public routes: `/service-list.xml`, `/epg/*`, `/logos/:id`, `/api/health`.

The admin UI prompts once for the token on the first `401` and stores it in `localStorage` (`dvbi-admin-token`).

**Deploy rule:** never expose the admin beyond a trusted network without `ADMIN_TOKEN` set, ideally
behind a reverse proxy that also terminates TLS and enforces SSO. Do not rely on network isolation alone.

## Conditional GET / caching

`/service-list.xml` emits `Last-Modified` (floored to whole seconds) and honours `If-Modified-Since`
(returns `304`). The timestamp is bumped on every config write (PUT, logo upload/delete, history restore).

## Rate limiting

Mutating routes (`PUT /api/config`, logo upload/delete, history restore) and the SSRF-guarded proxy
routes (`/api/test-url`, `/api/fetch-xml`) are rate-limited per client IP (in-memory, single-process —
a multi-instance deployment behind a load balancer would need a shared store, e.g. Redis).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | port to listen on |
| `ADMIN_TOKEN` | unset | when set, `/api/*` requires `Authorization: Bearer <token>`. **Unset means the admin API, including logo upload, is open to anyone who can reach the server.** |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH` | unset | PEM key and certificate; required unless `PLAIN_HTTP` is set, and the server does not start if they cannot be read |
| `PLAIN_HTTP` | unset | serve plain HTTP: `private-subnet` (clients on the same private subnet; endpoint URLs in the list are `http://`) or `behind-tls-proxy` (a reverse proxy terminates TLS; endpoint URLs are `https://`) |
| `DVBI_SCHEMAS` | `test/schemas` | directory holding the XSD and classification scheme files, for `npm run test:xsd` and `npm run test:cs`. Keep it outside the working tree. Without it both checks skip and exit 0. |

## Logging

Structured JSON-lines logs to stdout/stderr (one object per line: `time`, `level`, `msg`, plus fields).
Control verbosity with `LOG_LEVEL` (`error` | `warn` | `info` [default] | `debug`).

## HTTPS: mandatory for the metadata layer, not just recommended

**ETSI TS 103 770 V1.2.1 §7.3 ("Use of HTTP over TLS") requires HTTPS**, not just recommends it, for
connections between a DVB-I client and DVB-I metadata endpoints — explicitly named as Service List
Registries, Service List Servers, and Content Guide Servers. Quoting the clause directly:

> "All HTTP transactions and connections between the DVB-I client and DVB-I metadata endpoints,
> specifically Service List Registries, Service List Servers, Content Guide Servers, described in
> the present document **shall be performed using HTTP over TLS**... For the specific case that a
> DVB-I client connects to a DVB-I metadata endpoint located on the same private subnet (see clause
> 3 of IETF RFC 1918), HTTP may be used without TLS."

That means **this admin's `/service-list.xml` and `/epg/*` endpoints must be served over HTTPS** in
any deployment where the admin and the client(s) consuming its list are not on the same private
subnet — which is essentially any real production deployment. Plain HTTP is only acceptable under
the narrow same-private-subnet exception (note: the clause cites RFC 1918 private-subnet ranges,
not the loopback range specifically — treat "both running on `localhost` during local development"
as covered in spirit, not as a literal reading of the clause).

This requirement is scoped to the **metadata layer only** (the service list and EPG XML documents
themselves). It does not extend to media delivery URIs (the DASH/HLS stream URLs referenced inside
`DASHDeliveryParameters`/`OtherDeliveryParameters`) — the spec itself does not impose a "shall be
HTTPS" rule there, and includes a worked example using a plain `http://` URL in exactly that context.
Do not conflate the two: **the service list and EPG endpoints need HTTPS by spec; individual stream
URLs inside them are a separate matter and may legitimately be plain HTTP.**

The server terminates TLS itself via `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` (PEM file paths):
```
HTTPS_KEY_PATH=/etc/tls/key.pem HTTPS_CERT_PATH=/etc/tls/cert.pem npm start
```
If they are unset, or the files cannot be read, the server logs an error and does not start; there
is no fall back to plain HTTP. Plain HTTP has to be asked for with `PLAIN_HTTP`, naming the case:

- `PLAIN_HTTP=behind-tls-proxy`: a reverse proxy (nginx/Caddy/ALB) terminates TLS in front of the
  app, which is simpler for certificate rotation and is also where `ADMIN_TOKEN`-based auth should be
  paired with network-level access control. The endpoint URLs written into the service list use
  `https://`, the scheme clients reach the proxy with.
- `PLAIN_HTTP=private-subnet`: the clause 7.3 exception, for clients on the same private subnet.
  Endpoint URLs use `http://`. The server does not check where a client connects from; keeping it
  off other networks is the operator's job.

TLS 1.2 and 1.3 are offered (Node's defaults). The root certificates, cipher suites, signature
algorithms, key sizes and curves of ETSI TS 102 796 clause 11.2, which clause 7.3 refers to, are not
configured or checked here.

## Receiver: pinned player libraries + CSP

The receiver loads `hls.js` and `dash.js` from CDNs pinned to exact versions with Subresource Integrity:
- `hls.js@1.6.16`, `dash.js v5.2.0`

To upgrade a library: change the version in `rt-dvb-i-application/public/index.html`, then regenerate the hash:
```
curl -sL <pinned-url> | openssl dgst -sha384 -binary | openssl base64 -A
```
A Content-Security-Policy meta tag restricts scripts to `self` + those two CDNs (plus `'unsafe-inline'`
for the remaining inline handlers — see Known limitations in COMPLIANCE.md).

## Tests / CI

```
cd rt-dvb-i-application-provider    && npm test   # unit tests; XSD conformance runs only if you supply test/schemas/ yourself
cd rt-dvb-i-application && npm test   # unit tests + Playwright E2E (real Chromium)
```
Both projects have a `.github/workflows/test.yml` that runs the full suite on every push/PR
(the receiver's workflow additionally installs Chromium: `npx playwright install --with-deps chromium`).

The admin's XSD conformance check (`npm run test:xsd`) is opt-in and does not ship with this project —
see COMPLIANCE.md for what it validates and how to enable it locally with your own copy of the
ETSI/DVB schemas (this project does not bundle or redistribute third-party schema files).
