# Security policy

This is the default policy for every repository in
[dcyfr-labs](https://github.com/dcyfr-labs). A repository with its own
`SECURITY.md` overrides it.

## Reporting a vulnerability

**Do not open a public issue.** Report privately instead:

1. **Preferred:** open the repository's **Security** tab and choose
   **Report a vulnerability**. This creates a private advisory that only the
   maintainers can see.
2. **Or email** [security@dcyfr.ai](mailto:security@dcyfr.ai) with the subject
   `[Security] <repository>: <short description>`.

Please include the affected repository and version (or commit), steps to
reproduce, and the impact you expect. A proof of concept helps.

## What to expect

DCYFR Labs is a small team, so these are targets rather than guarantees:

- Acknowledgement within 3 business days.
- An initial assessment, and a fix plan for confirmed issues, within 10
  business days.
- Credit in the published advisory, unless you ask to stay anonymous.

We publish a GitHub security advisory once a fix is released.

## Supported versions

Security fixes go into the latest release of each package. Older releases are
patched only when a repository's own `SECURITY.md` says so.

## Scope

In scope: code in dcyfr-labs repositories and the packages published from them.
Out of scope: third-party dependencies (report those upstream; tell us too if
our usage makes them exploitable), and social engineering or denial-of-service
testing against DCYFR Labs infrastructure.
