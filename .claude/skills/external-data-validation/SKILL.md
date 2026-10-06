---
name: external-data-validation
description: Use when data enters the system from outside the codebase — API responses, file contents, environment variables, CLI arguments, database rows, third-party SDK returns — and needs a Zod schema. Covers the required parse pattern, what counts as external data, and why type assertions are banned. Triggers on "validate this response", "parse the config", "Zod schema", "is this data safe to use", "add a new connector's API types".
---

# External Data Validation

**Every piece of external data entering this system must be validated using Zod schemas without exception.**

External data must NEVER be used directly without validation. All external data must be parsed through Zod schemas that produce well-defined TypeScript types.

## What is External Data?

Any data that originates outside the application's trusted codebase:

- **API responses** - Data from REST APIs, GraphQL endpoints, webhooks
- **File contents** - JSON files, YAML files, text files, configuration files
- **Environment variables** - Values from `process.env`
- **User input** - Interactive prompts, form submissions, stdin
- **Command-line arguments** - Parsed CLI options and arguments (even after `commander` parsing)
- **Database query results** - Rows and columns from BigQuery and Firestore
- **Third-party library outputs** - Responses from external SDKs or packages

## Required Pattern

```typescript
import { z } from 'zod'

// 1. Define Zod schema
const DataSchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  optional: z.string().optional(),
})

// 2. Infer TypeScript type from schema
type Data = z.infer<typeof DataSchema>

// 3. Parse external data
const validated: Data = DataSchema.parse(externalData)

// 4. Use validated, type-safe data
processData(validated)
```

## Forbidden Patterns

1. **No unvalidated external data**:

   ```typescript
   // ❌ FORBIDDEN
   const config = JSON.parse(fileContents)
   const name = config.name // Unsafe! Could be undefined or wrong type

   // ✅ REQUIRED
   const config = ConfigSchema.parse(JSON.parse(fileContents))
   const name = config.name // Type-safe!
   ```

2. **No type assertions** - Do not use `as` to cast external data:

   ```typescript
   // ❌ FORBIDDEN
   const data = (await response.json()) as MyType

   // ✅ REQUIRED
   const data = MyTypeSchema.parse(await response.json())
   ```

3. **No trust in external types** - Even if a library claims to return a specific
   type, validate it. A connector's SDK type is a claim, not a guarantee.

## Integration with CLI Parsing

Command-line arguments are external data. Even after parsing with `commander`, validate the result with Zod:

```typescript
// 1. Parse with commander
program.parse(args, { from: 'user' })

// 2. Validate with Zod
const options = OptionsSchema.parse({
  version: program.args[0],
  dryRun: program.opts().dryRun,
})
```

See the `cli-utility-creation` skill for the full CLI pattern.

## Documentation

Check the installed Zod version in `package.json` and fetch current docs rather
than relying on training data:

- LLM-optimized docs: https://zod.dev/llms.txt
- Official website: https://zod.dev/
