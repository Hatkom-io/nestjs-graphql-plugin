#!/usr/bin/env node

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  type Decorator,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'ts-morph'

type Args = {
  srcRoot: string
  outputFile: string
  tsConfigFilePath: string
  nameOverrides: Map<string, string>
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let src: string | undefined
  let output: string | undefined
  let tsconfig: string | undefined
  const nameOverrides = new Map<string, string>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (
      (arg === '--src' ||
        arg === '--output' ||
        arg === '--tsconfig' ||
        arg === '--override') &&
      argv[i + 1]
    ) {
      const value = argv[++i]
      if (arg === '--src') src = path.resolve(process.cwd(), value)
      else if (arg === '--output') output = path.resolve(process.cwd(), value)
      else if (arg === '--tsconfig')
        tsconfig = path.resolve(process.cwd(), value)
      else {
        const eqIdx = value.indexOf('=')
        if (eqIdx !== -1) {
          nameOverrides.set(value.slice(0, eqIdx), value.slice(eqIdx + 1))
        }
      }
    }
  }

  if (!src || !output) {
    process.stderr.write(
      'Usage: nestjs-generate-enums --src <path> --output <path> [--tsconfig <path>] [--override <module::Name>=<GraphQLName>]...\n',
    )
    process.exit(1)
  }

  return {
    srcRoot: src,
    outputFile: output,
    tsConfigFilePath: tsconfig ?? path.join(src, '..', 'tsconfig.json'),
    nameOverrides,
  }
}

const { srcRoot, outputFile, tsConfigFilePath, nameOverrides } = parseArgs()

const SCHEMA_TYPE_DECORATORS = new Set([
  'Field',
  'ResolveField',
  'Query',
  'Mutation',
  'Subscription',
])

const project = new Project({ tsConfigFilePath })

const projectRoot = path.dirname(srcRoot)

const toSrcSpec = (absolutePath: string): string | undefined =>
  absolutePath.startsWith(projectRoot)
    ? path.relative(projectRoot, absolutePath).replace(/\.ts$/, '')
    : undefined

const extractTypeIdentifier = (decorator: Decorator): Node | undefined => {
  const arrow = decorator.getCallExpression()?.getArguments()[0]
  if (!arrow || !Node.isArrowFunction(arrow)) return undefined
  const body = arrow.getBody()
  if (Node.isIdentifier(body)) return body
  if (Node.isArrayLiteralExpression(body)) {
    const elements = body.getElements()
    if (elements.length === 1 && Node.isIdentifier(elements[0]))
      return elements[0]
  }
  return undefined
}

const isConstObjectEnum = (decl: Node): decl is VariableDeclaration => {
  if (!Node.isVariableDeclaration(decl)) return false
  const initializer = decl.getInitializer()
  const literal =
    initializer && Node.isAsExpression(initializer)
      ? initializer.getExpression()
      : initializer
  if (!literal || !Node.isObjectLiteralExpression(literal)) return false
  const props = literal.getProperties()
  return (
    props.length > 0 &&
    props.every((p) => {
      if (!Node.isPropertyAssignment(p)) return false
      const init = p.getInitializer()
      return init !== undefined && Node.isStringLiteral(init)
    })
  )
}

const resolveEnum = (
  identifier: Node,
): { name: string; sourceFilePath: string } | undefined => {
  if (!Node.isIdentifier(identifier)) return undefined
  const seen = new Set<unknown>()
  const visit = (
    sym: ReturnType<Node['getSymbol']>,
  ): { name: string; sourceFilePath: string } | undefined => {
    if (!sym || seen.has(sym)) return undefined
    seen.add(sym)
    for (const decl of sym.getDeclarations()) {
      if (Node.isEnumDeclaration(decl) || isConstObjectEnum(decl)) {
        return {
          name: decl.getName(),
          sourceFilePath: decl.getSourceFile().getFilePath(),
        }
      }
    }
    return visit(sym.getAliasedSymbol())
  }
  return visit(identifier.getSymbol())
}

const resolveSourceModule = (
  identifierText: string,
  enumFilePath: string,
  importingFile: SourceFile,
): string | undefined => {
  for (const decl of importingFile.getImportDeclarations()) {
    for (const named of decl.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName()
      if (localName !== identifierText) continue
      const raw = decl.getModuleSpecifierValue()
      if (!raw.startsWith('.')) return raw
      return toSrcSpec(
        path.resolve(path.dirname(importingFile.getFilePath()), raw),
      )
    }
  }
  return toSrcSpec(enumFilePath)
}

type Registration = {
  sourceModule: string
  identifier: string
  graphqlName: string
}

const registrations = new Map<string, Registration>()

for (const file of project.getSourceFiles()) {
  const filePath = file.getFilePath()
  if (!filePath.startsWith(srcRoot) || filePath === outputFile) continue

  for (const decorator of file.getDescendantsOfKind(SyntaxKind.Decorator)) {
    if (!SCHEMA_TYPE_DECORATORS.has(decorator.getName())) continue
    const identifier = extractTypeIdentifier(decorator)
    if (!identifier || identifier.getText() === 'ID') continue
    const resolved = resolveEnum(identifier)
    if (!resolved) continue
    const sourceModule = resolveSourceModule(
      identifier.getText(),
      resolved.sourceFilePath,
      file,
    )
    if (!sourceModule) continue
    const key = `${sourceModule}::${resolved.name}`
    registrations.set(key, {
      sourceModule,
      identifier: resolved.name,
      graphqlName: nameOverrides.get(key) ?? resolved.name,
    })
  }
}

// Also scan class properties in *.args.ts / *.input.ts files.
// The NestJS plugin injects @Field(() => EnumType) for these at compile time,
// but this scanner runs on source files where those decorators don't exist yet.
const ARGS_INPUT_MODEL_RE = /\.(args|input|model)\.ts$/

function extractBaseTypeIdentifier(typeNode: Node): Node | undefined {
  let node = typeNode

  if (Node.isUnionTypeNode(node)) {
    const nonNullable = node.getTypeNodes().filter((t) => {
      const k = t.getKind()
      return (
        k !== SyntaxKind.UndefinedKeyword &&
        !(
          Node.isLiteralTypeNode(t) &&
          t.getLiteral().getKind() === SyntaxKind.NullKeyword
        )
      )
    })
    if (nonNullable.length !== 1) return undefined
    node = nonNullable[0]
  }

  if (Node.isArrayTypeNode(node)) {
    node = node.getElementTypeNode()
  }

  if (!Node.isTypeReference(node)) return undefined
  const typeName = node.getTypeName()
  if (!Node.isIdentifier(typeName)) return undefined
  return typeName
}

for (const file of project.getSourceFiles()) {
  const filePath = file.getFilePath()
  if (!filePath.startsWith(srcRoot) || filePath === outputFile) continue
  if (!ARGS_INPUT_MODEL_RE.test(filePath)) continue

  for (const cls of file.getClasses()) {
    for (const prop of cls.getProperties()) {
      if (prop.getDecorators().some((d) => d.getName() === 'Field')) continue

      const typeNode = prop.getTypeNode()
      if (!typeNode) continue

      const identifier = extractBaseTypeIdentifier(typeNode)
      if (!identifier || identifier.getText() === 'ID') continue

      const resolved = resolveEnum(identifier)
      if (!resolved) continue

      const sourceModule = resolveSourceModule(
        identifier.getText(),
        resolved.sourceFilePath,
        file,
      )
      if (!sourceModule) continue

      const key = `${sourceModule}::${resolved.name}`
      registrations.set(key, {
        sourceModule,
        identifier: resolved.name,
        graphqlName: nameOverrides.get(key) ?? resolved.name,
      })
    }
  }
}

// Also scan resolver method return types and parameter types in *.resolver.ts.
// De-boilerplated resolvers omit the `@ResolveField(() => Enum)` arrow, so an
// enum used only in a bare return type (or parameter) would otherwise be missed.
const RESOLVER_RE = /\.resolver\.ts$/

const unwrapPromise = (node: Node): Node => {
  if (
    Node.isTypeReference(node) &&
    node.getTypeName().getText() === 'Promise'
  ) {
    const arg = node.getTypeArguments()[0]
    if (arg) return arg
  }
  return node
}

const registerEnumFromTypeNode = (
  typeNode: Node | undefined,
  file: SourceFile,
) => {
  if (!typeNode) return
  const identifier = extractBaseTypeIdentifier(unwrapPromise(typeNode))
  if (!identifier || identifier.getText() === 'ID') return
  const resolved = resolveEnum(identifier)
  if (!resolved) return
  const sourceModule = resolveSourceModule(
    identifier.getText(),
    resolved.sourceFilePath,
    file,
  )
  if (!sourceModule) return
  const key = `${sourceModule}::${resolved.name}`
  registrations.set(key, {
    sourceModule,
    identifier: resolved.name,
    graphqlName: nameOverrides.get(key) ?? resolved.name,
  })
}

for (const file of project.getSourceFiles()) {
  const filePath = file.getFilePath()
  if (!filePath.startsWith(srcRoot) || filePath === outputFile) continue
  if (!RESOLVER_RE.test(filePath)) continue

  for (const cls of file.getClasses()) {
    for (const method of cls.getMethods()) {
      registerEnumFromTypeNode(method.getReturnTypeNode(), file)
      for (const param of method.getParameters()) {
        registerEnumFromTypeNode(param.getTypeNode(), file)
      }
    }
  }
}

const sorted = [...registrations.values()].sort(
  (a, b) =>
    a.sourceModule.localeCompare(b.sourceModule) ||
    a.graphqlName.localeCompare(b.graphqlName),
)

const identifierUsage = sorted.reduce((counts, r) => {
  counts.set(r.identifier, (counts.get(r.identifier) ?? 0) + 1)
  return counts
}, new Map<string, number>())

const aliasFor = (r: Registration): string | undefined =>
  (identifierUsage.get(r.identifier) ?? 0) > 1 && r.identifier !== r.graphqlName
    ? r.graphqlName
    : undefined

const importsByModule = sorted.reduce((map, r) => {
  const alias = aliasFor(r)
  const clause = alias ? `${r.identifier} as ${alias}` : r.identifier
  const set = map.get(r.sourceModule) ?? new Set<string>()
  set.add(clause)
  return map.set(r.sourceModule, set)
}, new Map<string, Set<string>>())

const importLines = [...importsByModule]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([mod, names]) =>
      `import { ${[...names].sort().join(', ')} } from '${mod}'`,
  )

const registrationLines = sorted.map(
  (r) =>
    `registerEnumType(${aliasFor(r) ?? r.identifier}, { name: '${r.graphqlName}' })`,
)

const content = `// This file is generated by @hatkom/nestjs-graphql-plugin.
// Do not edit by hand. Regenerate by running nestjs-generate-enums.
//
// Centralised registerEnumType calls. Import once from app.module.ts
// and generate-schema.ts so the GraphQL schema can resolve every enum
// referenced in @Field(() => SomeEnum) decorators.

import { registerEnumType } from '@nestjs/graphql'
${importLines.join('\n')}

${registrationLines.join('\n')}
`

fs.writeFileSync(outputFile, content)
process.stdout.write(
  `Wrote ${sorted.length} enum registrations to ${path.relative(process.cwd(), outputFile)}\n`,
)
