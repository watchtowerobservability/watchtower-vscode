# Watchtower for VS Code

Production issues, traces, replays and hot functions next to the code that caused them.

- Issues whose stack has a frame in the open file are flagged on that exact line (Problems panel and CodeLens).
- CodeLens actions open the issue, its trace or its replay in Watchtower.
- Hot functions from your service's profiles get a CPU-share CodeLens.
- The API token lives in VS Code SecretStorage; it is never written to settings or logs.

## Install

Download `watchtower-vscode-0.1.0.vsix` from the GitHub release, then
`code --install-extension watchtower-vscode-0.1.0.vsix`.

## Quick start

1. Set `watchtower.apiUrl`, `watchtower.projectId` and (optional) `watchtower.service` in settings.
2. Run "Watchtower: Sign in with API token" and paste a read-only API token.
3. Open a file that appears in a stack trace.
4. "Watchtower: Refresh issues and profiles" re-reads the data.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `watchtower.apiUrl` | empty | API base URL |
| `watchtower.webUrl` | API URL | web app URL used for links |
| `watchtower.projectId` | empty | project id |
| `watchtower.service` | empty | service for hot-function CodeLens; empty disables them |
| `watchtower.maxIssues` | 30 | unresolved issues scanned |
| `watchtower.hotThresholdPct` | 5 | minimum CPU share for a hot-function lens |

## Integrations

| Feature | Status |
|---|---|
| Issue diagnostics per file | yes |
| Open issue, trace, replay | yes |
| Profile hot-function CodeLens | yes |

## Development

`npm test` runs the pure unit tests; `npm run test:vscode` launches VS Code with `@vscode/test-electron`
(CI runs it under `xvfb-run`).

## Verify a release

`gh attestation verify watchtower-vscode-0.1.0.vsix --repo watchtowerobservability/watchtower-vscode`

## License

Apache-2.0.
