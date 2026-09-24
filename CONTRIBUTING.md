# Contributing

Thanks for considering a contribution. For larger changes, open an issue first so we can agree on the behavior and scope.

## Development

- Use Node.js 22 or newer.
- Install dependencies with `npm ci`.
- Run `npm run typecheck` and `npm test` before opening a pull request.
- If changing the plugin entry point or build setup, run `npm run build` and `npm run bundle` as well.

Keep changes focused. Add or update tests for behavior changes, and update the README when user-facing behavior or configuration changes.

## Pull requests

Describe the user-visible change, note any compatibility impact, and include the commands you used to validate it. Do not include audit reports or repository data that may contain sensitive information.
