# Project Spec

This is an example spec template. Watchdog audits code changes against the
intent you express here. Write clearly — ambiguity weakens enforcement.

## Purpose

What this project is. One paragraph. The auditor uses this to understand
whether changes align with the project's core mission.

## Architecture

- Module boundaries (e.g., "API layer must not call database directly — use
  the repository layer")
- Dependency direction ("UI components never import from server/")
- Public API surface area

## Non-negotiable constraints

These must always hold. The LLM auditor flags violations as drift.

- All authentication goes through `AuthService.verify()` — no inline checks
- Database queries must use parameterized statements — no string concatenation
- Public API endpoints must validate input via the zod schemas in `schemas/`
- No `console.log` in production code paths — use the structured logger

## Code quality rules

Expressed as hard, mechanical constraints in `.watchdog/rules.yml` so the
auditor doesn't have to judge them:

- Max function length: 40 lines
- No force unwraps in Swift (`!`)
- No `any` type in TypeScript
- No TODO comments in merged code

## Testing

- Every new public function has a corresponding unit test
- Integration tests for every API endpoint
- Tests must run in < 30s total

## What good looks like

Concrete examples of patterns the agent should use and patterns to avoid.
The auditor calibrates its judgment against these examples.

### ✓ Good

```ts
async function createUser(input: unknown): Promise<User> {
  const validated = CreateUserSchema.parse(input);
  return await userRepository.create(validated);
}
```

### ✗ Bad

```ts
async function createUser(input: any) {
  return await db.query(`INSERT INTO users VALUES (${input.name})`);
}
```
