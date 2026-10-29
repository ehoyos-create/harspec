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
