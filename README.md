# @hatkom/nestjs-graphql-plugin

Two complementary tools that eliminate the GraphQL schema boilerplate you would otherwise write by hand in a NestJS project:

1. **TypeScript compiler plugin** — auto-injects `@Field()` decorators on class properties typed as [flavoured Prisma IDs](https://github.com/Hatkom-io/prisma-generator-flavoured-ids), enums, or configured scalar aliases. Also auto-injects `@ArgsType()` / `@InputType()` on undecorated classes in `*.args.ts` / `*.input.ts` files.
2. **`nestjs-generate-enums` CLI** — scans your source tree for enums referenced in GraphQL decorators **and** in class properties inside `*.args.ts` / `*.input.ts` files, then generates a single file of `registerEnumType(...)` calls you import once from your app module.

## Installation

```bash
npm install @hatkom/nestjs-graphql-plugin
# or
bun add @hatkom/nestjs-graphql-plugin
```

TypeScript must be installed separately (peer dependency, `>=5.0.0`).

---

## 1. TypeScript compiler plugin

### What it does

NestJS's built-in GraphQL plugin auto-adds `@Field()` for primitive types but skips branded IDs, enums, and custom scalars. This plugin fills three gaps:

- **Flavoured IDs** — injects `@Field(() => ID)` for properties typed as [prisma-generator-flavoured-ids](https://github.com/Hatkom-io/prisma-generator-flavoured-ids) (names matching `^[A-Z][A-Za-z0-9_]*Id$` imported from the configured module).
- **Enums** — uses the TypeScript type checker to detect both `enum Foo {}` and `const Foo = { ... } as const` enum patterns and injects `@Field(() => Foo)` automatically.
- **Scalar aliases** — optionally maps named exports from a shared module to their GraphQL scalar types (e.g. `float` → `@Field(() => Float)`).

It also auto-injects `@ArgsType()` on classes ending in `Args` inside `*.args.ts` files, and `@InputType()` on classes ending in `Input` inside `*.input.ts` files, so no class-level decorators are needed.

### Configuration

Register the plugin in `nest-cli.json` alongside `@nestjs/graphql`:

```json
{
  "compilerOptions": {
    "plugins": [
      "@nestjs/graphql",
      "@hatkom/nestjs-graphql-plugin"
    ]
  }
}
```

With options:

```json
{
  "compilerOptions": {
    "plugins": [
      "@nestjs/graphql",
      {
        "name": "@hatkom/nestjs-graphql-plugin",
        "options": {
          "idModulePattern": "@generated/prisma/",
          "scalarModule": "@myorg/shared",
          "scalars": {
            "float": "Float",
            "int": "Int"
          }
        }
      }
    ]
  }
}
```

### Plugin options

| Option | Type | Default | Description |
|---|---|---|---|
| `idModulePattern` | `string` (regex) | `@generated/prisma/` | Regex matched against the import path. Matching imports whose exported names satisfy `^[A-Z][A-Za-z0-9_]*Id$` are treated as ID types. |
| `scalarModule` | `string` | *(disabled)* | Module from which scalar aliases are imported. When omitted, scalar handling is skipped. |
| `scalars` | `Record<string, string>` | `{ float: "Float", int: "Int" }` | Map of exported identifier → GraphQL scalar name for imports from `scalarModule`. |
| `autoArgsType` | `boolean` | `true` | Auto-inject `@ArgsType()` on classes ending in `Args` inside `*.args.ts` files. |
| `autoInputType` | `boolean` | `true` | Auto-inject `@InputType()` on classes ending in `Input` inside `*.input.ts` files. |

### Behaviour

- For `*.args.ts` and `*.input.ts` files, auto-injects `@ArgsType()` / `@InputType()` on matching class names. Classes already carrying any GraphQL class decorator are left untouched.
- Inside eligible classes, injects `@Field()` for flavoured ID types, enums, and configured scalar aliases. Properties already carrying `@Field` or `@HideField` are skipped.
- Handles `T[]`, `Array<T>`, `T | null`, and optional (`?:`) for array-ness and nullability.

### Before / after

```typescript
// Before — explicit decorators required on every ID, enum, and class
@ArgsType()
export class FindInvoicesArgs {
  @Field(() => ID)
  fundId: FundId

  @Field(() => InvoiceStatus)
  status: InvoiceStatus

  page?: number
}

// After — everything injected automatically at compile time
export class FindInvoicesArgs {
  fundId: FundId
  status: InvoiceStatus
  page?: number
}
```

---

## 2. `nestjs-generate-enums` CLI

### What it does

NestJS requires every enum used in a GraphQL schema to be registered via `registerEnumType(MyEnum, { name: 'MyEnum' })`. This command scans your source tree and emits a single generated file that registers them all.

It detects enums from two sources:
- **GraphQL decorators** — any enum referenced via `@Field(() => MyEnum)`, `@Query`, `@Mutation`, `@Subscription`, or `@ResolveField`.
- **Args/Input class properties** — enum-typed properties in `*.args.ts` and `*.input.ts` files, even without an explicit `@Field()` decorator (since those are injected at compile time by the plugin).

### Usage

```bash
nestjs-generate-enums \
  --src apps/api/src \
  --output apps/api/src/@generated/registered-enums.ts \
  [--tsconfig apps/api/tsconfig.json] \
  [--override "src/@generated/prisma/client::SortOrder=CommitmentSortOrder"] \
  [--override "src/@generated/prisma/client::ISO3166CountryCode=CountryName"]
```

### Options

| Option | Required | Description |
|---|---|---|
| `--src` | Yes | Source directory to scan. Paths are resolved relative to `cwd`. |
| `--output` | Yes | Output file path. |
| `--tsconfig` | No | Path to `tsconfig.json`. Defaults to `<src>/../tsconfig.json`. |
| `--override` | No (repeatable) | Override the GraphQL name for a specific enum. Format: `<module>::<EnumName>=<GraphQLName>`. |

### Output

The generated file imports and registers every detected enum:

```typescript
// This file is generated by @hatkom/nestjs-graphql-plugin.
// Do not edit by hand. Regenerate by running nestjs-generate-enums.

import { registerEnumType } from '@nestjs/graphql'
import { CommitmentStatus, InvoiceStatus } from 'src/@generated/prisma/client'
import { SortDirection } from 'src/common/dto/sort.enum'

registerEnumType(CommitmentStatus, { name: 'CommitmentStatus' })
registerEnumType(InvoiceStatus, { name: 'InvoiceStatus' })
registerEnumType(SortDirection, { name: 'SortDirection' })
```

Import this file once — typically from `app.module.ts` and any schema generation script — so NestJS can resolve every enum referenced in your schema.

### Recommended workflow

Add the command to your Prisma generation script so it stays in sync:

```bash
#!/bin/bash
# prisma-generate.sh
prisma generate
nestjs-generate-enums \
  --src src \
  --output src/@generated/registered-enums.ts
```

---

## License

MIT
