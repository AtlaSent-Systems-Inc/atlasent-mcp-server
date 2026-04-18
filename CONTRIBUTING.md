# Contributing to atlasent-mcp-server

Thanks for your interest. This repo publishes `@atlasent/mcp-server` — the MCP (Model Context Protocol) server that lets Claude Desktop, Cursor, Claude Code, and other MCP-capable agents call AtlaSent authorization before executing an action.

## Ground rules

1. **MCP-spec compliant.** Tool and resource schemas must validate against the current MCP spec version used by mainstream clients.
2. **Fail-closed on missing credentials.** If the API key is absent or invalid, tools must refuse to execute rather than guess.
3. **Local-mode (no credentials) must still work** for the demo path. Don't break `npm run demo`.
4. **Strict TypeScript.** No `any` in new code. `npm run lint` must pass.
5. **Tests required** for tool-handler behavior changes.

## Local development

```bash
npm install
npm run build
npm test
npm run demo           # local-mode demo, no credentials
```

## Pull request checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run demo` still runs end-to-end
- [ ] New tool handlers have a matching test

## Reporting a security issue

Email **security@atlasent.io**. We acknowledge within 2 business days. Do not open a public issue for security-sensitive reports.

## License

By contributing, you agree that your contributions are licensed under the same license as this repository (see [`LICENSE`](./LICENSE)).
