# harspec

**Point it at a web app. Get a working app you own.**

`harspec` opens the site in your own browser, records what it does, and generates a
standalone application — backend, database and UI — from that behaviour. Your copy
runs on `localhost`, keeps working when the original changes, and contains **no**
HTML, CSS, JavaScript or assets from the target.

```bash
npx harspec reproduce https://calendly.com/rick -o my-app
cd my-app && npm start
```

```
harspec v0.1.0 · reproduce
source    calendly.com
app       Rick Pollak

  Event Types           1 records   /api/booking/profiles/rick/event_types
  Profile               1 records   /api/booking/profiles/rick

✓ server.mjs      own backend, seeded from the capture
✓ public/         own UI, no framework, no dependencies
✓ README.md

  run it:  cd my-app && npm start
  original code only: nothing from the target was copied
```

Two seconds later you have a real app: list, search, detail, create, update and
delete over the captured resources, plus a replayed response for every other
endpoint the site called.

---

## Why this is not a scraping tool

Most "clone the internet" projects copy the target: they mirror HTML, pull the JS
bundle, replay the CSS, and end up with a snapshot that breaks the moment the site
deploys and that you cannot legally ship. `harspec` does the opposite.

| | How it works |
|---|---|
| **Input** | A recording of behaviour: requests, responses, shapes. Same thing your DevTools Network tab shows you. |
| **Output** | New code. A Node server written from scratch, a UI written from scratch, seeded with the *data shapes* that were observed. |
| **Never** | The target's markup, stylesheets, bundles, images, fonts, logos, copy. |
| **Legal framing** | You are documenting an interface you can observe, then implementing it yourself — the same posture as reading an API doc and writing a client. Reverse engineering for interoperability. |

That distinction is not cosmetic. Copying a site is copyright infringement and it
does not even work well. Reimplementing behaviour from observed facts is what a
compatibility layer looks like, and it produces something that runs.

Read [DISCLAIMER.md](DISCLAIMER.md) before pointing this at anything you do not own.

## Quick start

```bash
# 1. the whole loop: capture the site, generate the app
npx harspec reproduce https://example.com -o my-app

# 2. run it
cd my-app && npm start        # → http://localhost:4000
```

That is it. No account, no API key, no headless browser download, no Chromium
sandbox flags, no `npm install` in the generated app.

If the site needs you to click around (or log in) before it shows the data you
care about, drive it yourself:

```bash
npx harspec reproduce https://example.com --interactive -o my-app
```

A real browser window opens. You use the site normally — search, open pages, sign
in with your own credentials if you want your own session recorded — and press
Enter when you are done. `harspec` never sees or stores a password: the browser
handles the login, and only the traffic is kept.

## What the generated app contains

```
my-app/
├── server.mjs          Node http server, no dependencies, in-memory database
├── public/
│   ├── index.html      own markup
│   ├── app.js          own front-end, no framework
│   └── styles.css      own design
├── package.json
├── README.md           what it is, what it does not do
└── harspec.json        provenance: source, date, resources
```

For every resource it found, the app gets working CRUD: `GET /collection`,
`GET /collection/:id`, `POST`, `PUT`, `PATCH`, `DELETE`, search and pagination.
Every other captured endpoint answers with the response observed at capture time,
so the UI does not hit dead ends.

The UI adapts to the data: cards with images when records have a thumbnail or
avatar, a table when they do not, a detail view with raw JSON, and a "Captured
endpoints" page that lists the whole observed surface.

## The rest of the pipeline

Same capture, three more artifacts:

```bash
npx harspec session.har
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

| Artifact | What it is |
|---|---|
| `openapi.json` / `openapi.yaml` | OpenAPI 3.1 built from observed calls |
| `client.ts` | Dependency-free typed TypeScript client, one method per operation |
| `report.md` / `findings.json` | Security findings, each citing the HAR entry that proves it |
| `app/` | The standalone app described above (`reproduce`) |

And if you have no capture yet:

```bash
npx harspec web https://app.example.com
```

reads only what an anonymous visitor receives — HTML, bundles, linked routes — and
writes `surface.md` plus a skeleton spec. Cheap, instant, no session, and it still
finds leaked keys and exposed source maps.

## Capturing

`harspec` can drive a local browser itself (Chrome, Chromium, Edge, Brave, Arc,
Dia, Vivaldi, Opera) over the DevTools protocol using only Node's built-in
WebSocket — no Playwright, no 300 MB download.

```bash
npx harspec capture https://example.com -o session.har
npx harspec capture https://example.com --interactive   # you drive, it records
```

Or use your own browser, which is often the best option:

| Browser | How |
|---|---|
| Chrome / Edge | DevTools → Network → right-click → **Save all as HAR with content** |
| Firefox | Network → gear → **Save All As HAR** |
| Safari | Network → **Export** |

Browse the flows you care about *before* exporting: ten minutes of clicking
produces a far better app than a single page load, because repeated calls mean
merged schemas and multi-page lists mean the tool can tell required from optional.

## Commands

```
harspec reproduce <url|har> [options]   capture (if a URL) → generate a standalone app
harspec capture   <url>     [options]   drive a local browser, write a HAR
harspec <capture.har>       [options]   spec + typed client + risk report
harspec web <url>           [options]   public surface only, no session, no browser

  -o, --out <dir>       output directory (default ./harspec-out)
  -i, --interactive     open a visible browser and record while you use the site
      --seconds <n>     hard stop for interactive capture (default 300)
      --title <text>    name for the generated app / API title
      --scan-bundles    (har) fetch the JS in the capture; leaked keys, source maps
      --replay          (har) replay captured writes with tampered fields
      --allow-host <h>  (har) extend the replay allowlist (repeatable)
  -q, --quiet           print only the output path
      --json            machine-readable summary, for CI
```

`reproduce` accepts a URL or a HAR, so `capture` and `reproduce` compose either
way: record now, generate later, generate again after changing the name.

## Honest limits

A generated app is a *behavioural* copy, not a source copy. That has consequences
you should know before you show it to anyone:

- **Business logic that never crossed the wire is not there.** Tax rules,
  ranking, permissions checks on the server: the capture shows results, not
  algorithms.
- **Writes are generic.** `POST /orders` creates a record; it does not charge a
  card, send an email, or reserve inventory.
- **Auth becomes a replayed response.** The generated app is open; it does not
  reproduce a login flow. Add real auth before exposing it.
- **Only what was captured exists.** Routes that were never visited are not
  invented.
- **It is a starting point, not a drop-in replacement.** You get a working
  skeleton with your data shapes and your real records — thrown away in minutes,
  which is the point.

Not designed for WebSocket-only APIs, GraphQL beyond introspection detection, or
binary payloads (protobuf, msgpack).

## Safety

Read [DISCLAIMER.md](DISCLAIMER.md). Short version:

- Run it against apps **you own or are authorised to test**.
- Passive analysis sends no traffic. `capture` uses your own browser and your own
  network, like DevTools does.
- `--replay` (tampered writes) is restricted to `localhost` and `127.0.0.1`
  unless you explicitly allow a host. Replaying tampered writes against someone
  else's production system is unauthorised testing, not research.
- Credentials are never stored, replayed or requested. If a session is needed,
  you log in yourself in the browser.
- The generated app does not contain the target's assets. If you publish a copy,
  rename it and replace anything that identifies its origin: name, logo, colours,
  wording, data.

## Verified on

Real sites, no account, 2026-10-29:

| Target | Mode | Result |
|---|---|---|
| `calendly.com/rick` | `reproduce` | 2 resources, 1 real event type, app runs |
| `www.hostinger.com` | `reproduce` | 10 products with prices and specs, app runs |
| `vercel.com` | `web` | Next.js · 10 API paths · 76 routes |
| `linear.app` | `web` | Next.js · 9 API paths · 40 routes |

`npm run e2e` runs the whole thing against the included demo target: capture,
spec, client (imported and called against the live API), report, and the generated
app (booted and exercised over HTTP). 55 assertions.

## Architecture

```
capture.ts  ──▶ HAR ──▶ har.ts      normalize, template paths, group into operations
                          ├─▶ infer.ts    JSON Schema from every sample of every field
                          ├─▶ openapi.ts  OpenAPI 3.1
                          ├─▶ client.ts   typed TypeScript client
                          ├─▶ report.ts   findings with evidence
                          └─▶ reproduce.ts app model → server + UI
```

The core is deterministic: no model calls, same input in, same files out. That is
what makes the output reviewable — you can diff two runs, read the generator, and
trust what it emits.

## License

MIT. See [LICENSE](LICENSE).
