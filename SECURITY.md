# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this repository, **do not open a public GitHub issue**. Email [security@atlasent.io](mailto:security@atlasent.io) with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- The version or commit SHA where you observed the issue
- Your contact information for follow-up

We acknowledge all reports within **2 business days**.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `atlasent-mcp-server` (this repo) | The AtlaSent SaaS service itself (report separately) |
| MCP tool input validation and injection risks | Third-party MCP hosts (Claude Desktop, etc.) |
| API key handling in remote mode | Social engineering or phishing |
| Fail-closed behavior of `evaluate` and `verify` tools | Theoretical vulnerabilities without a working PoC |

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release on `main` | Yes |
| Previous minor release | Security fixes only |
| Older versions | No |

## Disclosure policy

1. Reporter submits to security@atlasent.io
2. We acknowledge within 2 business days
3. We assess severity (CVSS score where applicable)
4. We develop and test a fix in a private fork
5. We coordinate a disclosure date (typically 14–90 days depending on severity)
6. We release a patched version and publish a GitHub Security Advisory
7. Reporter is credited in the advisory unless they request anonymity

We follow [responsible disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html) principles.

## Severity definitions

| Severity | Example | Target fix timeline |
|----------|---------|--------------------|
| Critical | Prompt injection enabling auth bypass, permit forgery via MCP tool | 24–48 hours |
| High | API key leakage through MCP tool responses, SSRF via `baseUrl` | 7 days |
| Medium | Tool output that misleads the host model about authorization state | 30 days |
| Low | Minor information disclosure in error messages | 90 days |

## Security architecture overview

- **Local mode**: Runs as a stdio MCP server. No network calls; evaluation logic is local. No credentials required.
- **Remote mode**: Forwards tool calls to the AtlaSent edge function API using a Bearer token. The API key is read from the environment and never appears in MCP tool responses.
- **Fail-closed**: If the AtlaSent API is unreachable or returns an error, the `evaluate` tool returns `{"decision": "deny"}` by default. This behavior can be verified with `ATLASENT_FAIL_CLOSED=true`.
- **Input validation**: All tool inputs are validated against a JSON Schema before forwarding to the API. Malformed inputs are rejected with an error, not forwarded.
- **No persistent state**: The server holds no session state between MCP calls. Each call is independently authorized.

## Known limitations

- `baseUrl` can be overridden via environment variable, which allows pointing the server at a non-AtlaSent host. Callers are responsible for ensuring the target host is trusted.
- In local mode, policy evaluation runs locally and is only as current as the last policy sync. Stale policies are a known risk if the policy cache is not refreshed.

## Security contact

- **Email**: security@atlasent.io
- **PGP**: Available on request
- **Response SLA**: 2 business days for acknowledgement
