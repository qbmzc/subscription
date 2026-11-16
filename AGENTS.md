# Repository Guidelines

## Project Structure & Module Organization

This TypeScript Cloudflare Worker manages sing-box and mihomo subscriptions using Workers KV.

- `index.ts`: Worker entry point and request routing.
- `src/`: panel rendering, authentication, APIs, subscription imports, format translation, configuration merging, and KV persistence. Shared types live in `src/types.ts`.
- `template/`: default sing-box JSON and mihomo YAML templates used to initialize state.
- `wrangler.toml`: Worker configuration, `CONFIG_KV` binding, and text asset rules.

There is no test directory or frontend asset pipeline; panel rendering lives in `src/panel.ts`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev`: start the local Wrangler development server.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm run deploy`: bundle and deploy the Worker to Cloudflare; use only when deployment is intended.

Wrangler handles bundling. No separate build script, lint command, or automated test runner is configured.

## Coding Style & Naming Conventions

Follow existing TypeScript: two-space indentation, single quotes, semicolons, and ES module imports. Use `camelCase` for functions and variables, `PascalCase` for types, and descriptive lowercase filenames with hyphens where needed, such as `mihomo-to-sing.ts`. TypeScript strict mode is enabled; no formatter is configured.

Keep main functions focused on the normal business flow and move validation and implementation details into helpers. Extract helpers for reuse, complex logic, or an independent concept. Validate external data once at entry. Comment only non-obvious constraints. Avoid speculative safeguards or unrelated changes; explain failure scenarios, likelihood, and code cost before requesting approval for extra defenses. Update generated files through their source.

## Testing Guidelines

Run `npm run typecheck` before submitting. Manually exercise affected behavior with `npm run dev`, including authentication, imports, and downloads selected by User-Agent or `?target=mihomo`, `?target=sing-box`, and `?target=sing-box-android`, as relevant. Record checks in the PR. No coverage threshold or test naming convention exists. Tests should exercise real implementations and minimize mocks.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, such as `Refine subscription panel layout`; follow that pattern. History does not establish a Conventional Commits requirement. PRs should describe the change, list validation, link relevant issues, and include screenshots for panel changes.

## Security & Configuration

Configure your own KV namespace. Set `ADMIN_PASSWORD` using `wrangler secret put ADMIN_PASSWORD`; default `admin/admin` login is disabled. Keep credentials and subscription tokens out of commits. External API access requires a configured token; customize public paths through the panel.
