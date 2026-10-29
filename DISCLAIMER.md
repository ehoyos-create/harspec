# Disclaimer

`harspec` analyses HTTP traffic that a browser already recorded. That makes it a
development and audit tool, not an attack tool — but it can be pointed in the
wrong direction, so read this first.

## Authorised use only

Use `harspec` only on applications that you own, that you operate, or that you
have explicit written permission to test. Depending on your jurisdiction this may
include computer-misuse law (for example the U.S. Computer Fraud and Abuse Act,
the UK Computer Misuse Act, or Colombia's Ley 1273 de 2009). Running security
tests without authorisation can be a criminal offence regardless of intent.

## What the tool does by default

- Reads a HAR file you supply.
- Produces files in an output directory you choose.
- Sends **no network requests**.

## What it does when you opt in

- `capture <url>` opens your own local browser and records the traffic of that
  visit, exactly as DevTools' Network panel would. It uses your machine and your
  network; it does not defeat bot protection, and it does not touch credentials.
- `--interactive` keeps that browser visible so you drive it yourself. If the site
  needs a login, you log in — the password goes to the site, never to `harspec`.
- `reproduce <url>` is `capture` followed by generation, in one step.
- `--scan-bundles` performs `GET` requests for JavaScript files that already
  appear in your capture, plus any source map they reference. Same origin, same
  resources your browser loaded.
- `--replay` re-sends requests from the capture with one field modified, and
  compares the response.

`--replay` is restricted to `localhost` and `127.0.0.1` by default. Extending the
allowlist with `--allow-host` is an explicit statement that you are authorised to
test that host. Do not extend it for third-party systems you do not control.

Replaying a tampered write against a production service you do not own is
unauthorised testing. It can corrupt data, trigger fraud controls, or violate the
target's terms of service.

## Generated apps are not copies

`reproduce` does not redistribute the target's work. It emits original source
code — a new server, a new UI, a new stylesheet — derived from observable facts:
which resources exist, what fields they carry, and what a real response looked
like. No HTML, CSS, JavaScript, fonts, images or copy from the target are copied
or bundled.

That does not make every use acceptable. Publishing a generated app is still
subject to:

- **Trademark.** Do not ship the target's name, logo, or confusingly similar
  branding. Rename it.
- **Copyright in data and content.** Records captured from a page may contain
  text, images or user content owned by someone else. Do not republish content you
  have no right to.
- **Terms of service and contract.** Automated access may be restricted even when
  the data is public.
- **Privacy.** Captured records can contain personal data. Delete what you do not
  need.

Use it to understand an interface, rebuild something you own, keep a dead app
alive, or learn how a product you admire is put together. Do not use it to pass
off someone else's product as yours.

## Credentials

`harspec` never asks for, stores, or replays credentials on your behalf. It uses
the session you already had open in your browser, because that session is yours.

Be aware that a HAR file can contain session cookies, tokens and personal data.
Treat a capture as a secret: do not commit it, do not paste it into an issue, and
delete it when you are done. The included `.gitignore` excludes `*.har` for this
reason.

## Findings are not proof

Every finding describes what was observed, with the entry that proves it. Some
are candidates, not confirmed vulnerabilities — the IDOR check in particular says
so in its own text. Confirm before reporting anything to a third party.

## No warranty

The software is provided under the MIT licence, without warranty of any kind. The
authors are not responsible for misuse or for any damage caused by running these
checks against systems you were not authorised to test.
