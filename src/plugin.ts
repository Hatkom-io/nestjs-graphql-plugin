import * as ts from 'typescript'

/**
 * Options accepted via nest-cli.json `plugins` entry:
 *
 *   { "name": "@hatkom/nestjs-graphql-plugin", "options": { ... } }
 *
 * All fields are optional — the defaults cover a standard
 * prisma-generator-flavoured-ids setup.
 */
export type PluginOptions = {
  /**
   * Regex pattern matching the module path from which flavoured IDs are
   * imported. Defaults to `@generated/prisma/` (prisma-generator-flavoured-ids
   * default output location).
   */
  idModulePattern?: string
  /**
   * Module from which shared scalar aliases are imported.
   * When omitted, scalar alias handling is disabled.
   */
  scalarModule?: string
  /**
   * Map of local identifier → GraphQL scalar name for exports of `scalarModule`.
   * Defaults to `{ float: "Float", int: "Int" }`.
   */
  scalars?: Record<string, string>
}

const GRAPHQL_CLASS_DECORATORS = new Set([
  'ObjectType',
  'InputType',
  'ArgsType',
  'InterfaceType',
])

const SKIP_PROPERTY_DECORATORS = new Set(['Field', 'HideField'])

const FLAVORED_ID_PATTERN = /^[A-Z][A-Za-z0-9_]*Id$/

const DEFAULT_ID_MODULE_PATTERN = /@generated\/prisma\//
const DEFAULT_SCALARS = new Map([
  ['float', 'Float'],
  ['int', 'Int'],
])

function getDecoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text
  }
  if (ts.isIdentifier(expr)) {
    return expr.text
  }
  return undefined
}

function getDecorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []
}

function isGraphQLClass(node: ts.ClassDeclaration): boolean {
  return getDecorators(node).some((d) => {
    const name = getDecoratorName(d)
    return name !== undefined && GRAPHQL_CLASS_DECORATORS.has(name)
  })
}

function hasSkipDecorator(node: ts.PropertyDeclaration): boolean {
  return getDecorators(node).some((d) => {
    const name = getDecoratorName(d)
    return name !== undefined && SKIP_PROPERTY_DECORATORS.has(name)
  })
}

function collectFlavoredIdNames(
  sourceFile: ts.SourceFile,
  idModulePattern: RegExp,
): Set<string> {
  const result = new Set<string>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!idModulePattern.test(stmt.moduleSpecifier.text)) continue
    const clause = stmt.importClause
    if (!clause?.namedBindings) continue
    if (!ts.isNamedImports(clause.namedBindings)) continue
    for (const element of clause.namedBindings.elements) {
      const localName = element.name.text
      if (FLAVORED_ID_PATTERN.test(localName)) {
        result.add(localName)
      }
    }
  }
  return result
}

function collectSharedScalars(
  sourceFile: ts.SourceFile,
  scalarModule: string | undefined,
  scalars: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>()
  if (!scalarModule) return result
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== scalarModule) continue
    const clause = stmt.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue
    for (const element of clause.namedBindings.elements) {
      const originalName = element.propertyName?.text ?? element.name.text
      const localName = element.name.text
      const gqlScalar = scalars.get(originalName)
      if (gqlScalar !== undefined) {
        result.set(localName, gqlScalar)
      }
    }
  }
  return result
}

type TypeAnalysis = {
  isArray: boolean
  isNullable: boolean
  gqlScalar: string
}

function analyzeType(
  typeNode: ts.TypeNode | undefined,
  isOptional: boolean,
  flavoredIdNames: Set<string>,
  sharedScalars: Map<string, string>,
): TypeAnalysis | undefined {
  if (!typeNode) return undefined

  let isNullable = isOptional
  let inner: ts.TypeNode = typeNode

  if (ts.isUnionTypeNode(inner)) {
    const nonNullable: ts.TypeNode[] = []
    for (const t of inner.types) {
      if (
        ts.isLiteralTypeNode(t) &&
        t.literal.kind === ts.SyntaxKind.NullKeyword
      ) {
        isNullable = true
        continue
      }
      if (t.kind === ts.SyntaxKind.UndefinedKeyword) {
        isNullable = true
        continue
      }
      nonNullable.push(t)
    }
    if (nonNullable.length !== 1) return undefined
    inner = nonNullable[0]
  }

  let isArray = false
  if (ts.isArrayTypeNode(inner)) {
    isArray = true
    inner = inner.elementType
  } else if (
    ts.isTypeReferenceNode(inner) &&
    ts.isIdentifier(inner.typeName) &&
    inner.typeName.text === 'Array' &&
    inner.typeArguments?.length === 1
  ) {
    isArray = true
    inner = inner.typeArguments[0]
  }

  if (!ts.isTypeReferenceNode(inner) || !ts.isIdentifier(inner.typeName)) {
    return undefined
  }

  const name = inner.typeName.text

  if (flavoredIdNames.has(name)) {
    return { isArray, isNullable, gqlScalar: 'ID' }
  }

  const gqlScalar = sharedScalars.get(name)
  if (gqlScalar !== undefined) {
    return { isArray, isNullable, gqlScalar }
  }

  return undefined
}

function createFieldDecorator(
  analysis: TypeAnalysis,
  namespaceIdent: ts.Identifier,
): ts.Decorator {
  const fieldAccess = ts.factory.createPropertyAccessExpression(
    namespaceIdent,
    ts.factory.createIdentifier('Field'),
  )
  const scalarAccess = ts.factory.createPropertyAccessExpression(
    namespaceIdent,
    ts.factory.createIdentifier(analysis.gqlScalar),
  )

  const typeRef = analysis.isArray
    ? ts.factory.createArrayLiteralExpression([scalarAccess], false)
    : scalarAccess

  const arrow = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    typeRef,
  )

  const args: ts.Expression[] = [arrow]
  if (analysis.isNullable) {
    args.push(
      ts.factory.createObjectLiteralExpression(
        [
          ts.factory.createPropertyAssignment(
            'nullable',
            ts.factory.createTrue(),
          ),
        ],
        false,
      ),
    )
  }

  return ts.factory.createDecorator(
    ts.factory.createCallExpression(fieldAccess, undefined, args),
  )
}

function transformClass(
  node: ts.ClassDeclaration,
  flavoredIdNames: Set<string>,
  sharedScalars: Map<string, string>,
  namespaceIdent: ts.Identifier,
  context: ts.TransformationContext,
  state: { modified: boolean },
): ts.ClassDeclaration {
  const visitor = (member: ts.Node): ts.Node => {
    if (!ts.isPropertyDeclaration(member)) return member
    if (hasSkipDecorator(member)) return member

    const analysis = analyzeType(
      member.type,
      member.questionToken !== undefined,
      flavoredIdNames,
      sharedScalars,
    )
    if (!analysis) return member

    state.modified = true
    const decorator = createFieldDecorator(analysis, namespaceIdent)
    const modifiers: ts.ModifierLike[] = [
      decorator,
      ...(member.modifiers ?? []),
    ]

    return ts.factory.updatePropertyDeclaration(
      member,
      modifiers,
      member.name,
      member.questionToken,
      member.type,
      member.initializer,
    )
  }

  return ts.visitEachChild(node, visitor, context) as ts.ClassDeclaration
}

function buildNamespaceRequireStatement(
  namespaceIdent: ts.Identifier,
): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          namespaceIdent,
          undefined,
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createIdentifier('require'),
            undefined,
            [ts.factory.createStringLiteral('@nestjs/graphql')],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  )
}

function makeTransformer(
  options: PluginOptions | undefined,
  _program: ts.Program | undefined,
): ts.TransformerFactory<ts.SourceFile> {
  const idModulePattern = new RegExp(
    options?.idModulePattern ?? DEFAULT_ID_MODULE_PATTERN.source,
  )
  const scalarModule = options?.scalarModule
  const scalars = options?.scalars
    ? new Map(Object.entries(options.scalars))
    : DEFAULT_SCALARS

  return (context) => (sourceFile) => {
    if (sourceFile.isDeclarationFile) return sourceFile

    const flavoredIdNames = collectFlavoredIdNames(sourceFile, idModulePattern)
    const sharedScalars = collectSharedScalars(
      sourceFile,
      scalarModule,
      scalars,
    )
    if (flavoredIdNames.size === 0 && sharedScalars.size === 0)
      return sourceFile

    const namespaceIdent = ts.factory.createUniqueName('__pid_graphql')
    const state = { modified: false }

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isClassDeclaration(node) && isGraphQLClass(node)) {
        return transformClass(
          node,
          flavoredIdNames,
          sharedScalars,
          namespaceIdent,
          context,
          state,
        )
      }
      return ts.visitEachChild(node, visit, context)
    }

    const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile
    if (!state.modified) return transformed

    const statements = [...transformed.statements]
    let insertAt = 0
    for (let i = 0; i < statements.length; i++) {
      if (ts.isImportDeclaration(statements[i])) {
        insertAt = i + 1
      }
    }
    statements.splice(
      insertAt,
      0,
      buildNamespaceRequireStatement(namespaceIdent),
    )

    return ts.factory.updateSourceFile(transformed, statements)
  }
}

// NestJS CLI plugin contract — both forms are supported.
export const before = (
  options: PluginOptions,
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> => makeTransformer(options, program)

export default (
  program: ts.Program,
  options: PluginOptions,
): ts.TransformerFactory<ts.SourceFile> => makeTransformer(options, program)
