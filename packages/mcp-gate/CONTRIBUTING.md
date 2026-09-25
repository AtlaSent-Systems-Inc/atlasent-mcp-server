# Contributing to Gate

Start with one real workflow and a declarative JSON policy pack. Include your name,
the server/version tested, the exact tool semantics, supported arguments, and a test
showing an unsafe call never reaches the upstream. Never infer safety from a tool's name
or readOnlyHint. Reviewers must inspect the target server's actual behavior.

Template (replace the demo tool and arguments with the verified server contract):

```json
{
  "version": 1,
  "default": "deny",
  "rules": [
    {"id":"sandbox-only", "tool":"set_status", "kind":"write", "effect":"allow", "argumentsEquals":{"environment":"sandbox","status":"ready"}}
  ]
}
```

Run `node cli.mjs check your-pack.json` and `npm test` from this directory.
Submit one PR containing the pack, tests and a short explanation of its enforcement limits.
Include allowed, denied, extra-argument, unknown-tool and secret-noncapture cases.
Do not add execute-on-install hooks or remotely loaded code. Contributions are
community-contributed until a maintainer reviews the pinned revision; do not self-label
as certified or AtlaSent-reviewed. Nothing auto-installs or auto-updates from a PR.
Report security issues through the repository's SECURITY.md process.

Future connector and verifier interfaces must be versioned and tested before we accept
executable extensions. Current extension surface is declarative policy packs only.
