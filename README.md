# harspec

**Turn recorded web traffic into an OpenAPI spec, a typed TypeScript client, and a risk report.**

You browse an app. You export the HAR. `harspec` reconstructs the API behind it — deterministically, with zero dependencies, and with evidence for every claim.

```bash
harspec session.har
```

No capture yet? Point it at a URL instead:

```bash
harspec web https://app.example.com
```

```
harspec v0.1.0 · static mode (no session)
url       https://vercel.com
stack     Next.js
read      11 resources · 10 API paths · 76 UI routes
```

```
harspec v0.1.0
target   app.example.com
capture  187 requests → 34 operations

✓ openapi.json  34 paths, 41 operations
✓ openapi.yaml
✓ client.ts     34 methods
✓ report.md     9 findings (2 critical, 4 high, 3 medium)

  CRITICAL  Server trusts client-supplied `total`
  CRITICAL  Stripe secret key found in a client bundle
  HIGH      CORS allows any origin together with credentials
  HIGH      Object access by raw identifier looks unchecked
```

---

## Why this exists

Every "reverse engineer the web" tool today falls into one of two buckets:

- **Traffic captures** that dump a HAR and leave you to read it.
- **Endpoint scrapers** that grep for URLs in JavaScript and hand you a list of dead links.

Neither gives you something you can *build against*. `harspec` closes the loop: the capture becomes a spec, the spec becomes a client, and the client is proven to work against the real API.

Three design rules make the output trustworthy:

1. **The core is deterministic.** No model calls. Same HAR in, byte-identical files out. You can diff two runs, review the generator, and trust the result.
2. **Every finding cites evidence.** Not "this looks vulnerable" but `POST /api/cart/items accepted price set to 0 (HTTP 201)` plus the HAR entry index that proves it.
3. **It says what it does not know.** Inference is conservative by design. A field is only marked required if it appeared in every observed sample.

## Two modes, one honest difference

| | `harspec web <url>` | `harspec <capture.har>` |
|---|---|---|
| Needs a session | No | Only what your browser already had |
| Network activity | One page + its own assets | None (passive by default) |
| API paths | Discovered in the bundle | Discovered **and exercised** |
| Parameters and schemas | — | Inferred from real traffic |
| Typed client | — | Yes, and it is tested against the live API |
| Works behind anti-bot | Yes, it is a plain GET | Yes |

Static mode reads what any anonymous visitor receives: HTML, the JavaScript it ships, the routes it links to. It is the right first look — cheap, instant, no legal ambiguity. It cannot see schemas, because it never calls the API.

HAR mode is the full pipeline. You browse once, export, and get the contract plus a client that runs.

## What you get

| Artifact | Mode | What it is |
|---|---|---|
| `openapi.json` / `openapi.yaml` | both | HAR: OpenAPI 3.1 built from observed calls. web: a skeleton of discovered paths, marked `x-harspec-mode: static` |
| `client.ts` | HAR | Dependency-free TypeScript client, one typed method per operation |
| `surface.md` | web | Stack, API paths, UI routes, third-party hosts, auth signals |
| `report.md` | both | Security findings with evidence, impact and remediation |
| `findings.json` | both | The same findings, machine-readable |

## Try it in 60 seconds

No install, no build step. The repo ships with a deliberately vulnerable demo app so the whole pipeline runs offline:

```bash
git clone https://github.com/YOU/harspec && cd harspec
npm run e2e
```

That starts the demo target, records a session, runs the full pipeline and asserts 32 conditions — including calling the **generated client** against the **live API**. If it passes, the tool works.

Or do it by hand:

```bash
npm run demo:serve          # terminal 1 — intentionally vulnerable target on :3000
npm run demo:record         # terminal 2 — writes demo/session.har
node src/cli.ts demo/session.har --scan-bundles --replay
```

Node 22.18+ and 24 run the TypeScript sources directly. On older versions, `npm run build` and use `node dist/cli.js`.

## Verified on

Real sites, static mode, no session, 2026-10-29:

| Target | Detected stack | API paths | UI routes |
|---|---|---|---|
| `vercel.com` | Next.js | 10 | 76 |
| `linear.app` | Next.js | 9 | 40 |
| `notion.so` | Next.js | 6 | 58 |
| included demo | vanilla | 7 | 0 |

Static mode reads public bundles only. HAR mode is what proves the contract.

## Install

```bash
npm install -g harspec
# or, without installing:
npx harspec session.har
```

Requires Node 20.11+. There are **no runtime dependencies** — the published package is a few files and a `bin`.

## Capturing a session

Use your own browser and your own session. `harspec` never handles credentials.

| Browser | How |
|---|---|
| Chrome / Edge | DevTools → Network → right-click → **Save all as HAR with content** |
| Firefox | Network → gear icon → **Save All As HAR** |
| Safari | Network → **Export** |
| mitmproxy | `mitmdump --save-stream-file session.har` (convert to HAR first) |

Browse the flows you care about *before* exporting. Ten minutes of clicking produces a far better spec than one page load: repeated calls mean merged schemas, and multi-page lists mean the tool can tell required from optional fields.

## Commands

```
harspec <capture.har> [options]
harspec web <url>     [options]

  -o, --out <dir>       output directory (default ./harspec-out)
      --title <text>    API title in the spec
      --scan-bundles    (har) fetch the JS in the capture; look for leaked keys and source maps
      --replay          (har) replay captured writes with tampered fields
      --allow-host <h>  (har) extend the replay allowlist (repeatable)
  -q, --quiet           print only the output path
      --json            machine-readable summary, for CI
```

`--replay` and `--scan-bundles` are **off by default** because they send requests. See [Safety](#safety).

## What the report checks

Passive checks run on the capture alone and send nothing:

| Check | Severity |
|---|---|
| Plaintext HTTP | high |
| CORS wildcard combined with credentials | high |
| Debug / ops endpoints returning 2xx | high |
| Token-looking values in query strings | high |
| Object access by raw id (IDOR candidate) | high/medium |
| Missing CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` | medium |
| Verbose stack traces and database errors | medium |
| Cookie missing `HttpOnly` / `Secure` / `SameSite` | medium/low |
| GraphQL introspection enabled | medium |
| Wildcard CORS without credentials | low |
| Stack version disclosed in headers | info |

Active checks (`--replay`, localhost by default):

| Check | What it proves |
|---|---|
| Client-supplied price/total accepted | Money can be set by the client |
| Negative quantity accepted | Sign inversion of a transaction |
| Invalid email accepted | Validation exists only in the browser |
| `role` / `is_admin` accepted from the payload | Privilege escalation |

Bundle scan (`--scan-bundles`):

| Check | What it proves |
|---|---|
| Publicly served `.map` files | Original source is recoverable |
| AWS / Stripe / Google / GitHub / Slack / SendGrid keys | A credential is public |
| `10.x` / `192.168.x` / `.internal` hosts in JS | Private topology leaked |

## Scope

`harspec` reconstructs what your browser already fetched. It is honest about the edges:

**Good at**
- React / Vue / Angular / Next / Nuxt SPAs using JSON over HTTP
- REST APIs, including ones behind a login you performed yourself
- Large captures — grouping and schema merging are linear in request count

**Not designed for**
- WebSocket-only or gRPC APIs (frames are captured but not modelled)
- Binary payloads (protobuf, msgpack)
- GraphQL schema reconstruction beyond introspection detection
- De-obfuscating minified bundles — the source map matters more than the minifier
- Anything requiring adversarial anti-bot bypass

If the app is behind Cloudflare Enterprise or DataDome, capture from your own browser anyway: the tool consumes the HAR, so it never needs to drive a headless browser.

## Safety

Read [DISCLAIMER.md](DISCLAIMER.md). Short version:

- Run it against apps **you own or are authorised to test**.
- Passive analysis (the default) sends no traffic.
- `--replay` is restricted to `localhost` and `127.0.0.1` unless you explicitly add a host. That restriction is deliberate: replaying tampered writes against a third party is unauthorised testing, not research.
- The tool never stores, replays or prompts for credentials. Use your own browser session.

## Architecture

```
HAR ──▶ har.ts      normalize, template paths, group into operations
     ──▶ infer.ts   infer JSON Schema from every sample of every field
     ──▶ openapi.ts emit OpenAPI 3.1
     ──▶ client.ts  emit TypeScript client
     ──▶ report.ts  passive findings with evidence
     ──▶ replay.ts  opt-in: tamper and compare
     ──▶ scan.ts    opt-in: fetch bundles, look for keys and maps
```

Each stage is pure and independently testable. `scripts/e2e.mjs` is the acceptance test: it fails if the spec, the client, or any expected finding regresses.

## Roadmap

- [ ] GraphQL operation extraction from captured queries
- [ ] OpenAPI → Postman collection and `curl` reproducers
- [ ] Diff two captures: what changed between app versions
- [ ] Optional MCP server so agents can query the reconstructed API
- [ ] `web --browser`: drive Chromium once to build the HAR automatically
- [ ] Download resolvable source maps and recover original sources

## License

MIT. See [LICENSE](LICENSE).
