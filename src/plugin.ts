import * as path from 'path'
import * as ts from 'typescript'

/**
 * Options accepted via nest-cli.json `plugins` entry:
 *
 *   { "name": "@hatkom/nestjs-graphql-plugin", "options": { ... } }
 *
 * All fields are optional — the defaults cover a standard
 * prisma-generator-flavoured-ids + NestJS project layout.
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
  /**
   * Auto-inject `@ArgsType()` on classes whose name ends in `Args` inside
   * `*.args.ts` files. Classes already carrying any GraphQL class decorator
   * are left untouched. Defaults to `true`.
   */
  autoArgsType?: boolean
  /**
   * Auto-inject `@InputType()` on classes whose name ends in `Input` inside
   * `*.input.ts` files. Classes already carrying any GraphQL class decorator
   * are left untouched. Defaults to `true`.
   */
  autoInputType?: boolean
  /**
   * Auto-inject `@ObjectType()` on classes whose name ends in `Model` inside
   * `*.model.ts` files. Classes already carrying any GraphQL class decorator
   * are left untouched. Defaults to `true`.
   */
  autoObjectType?: boolean
}

const GRAPHQL_CLASS_DECORATORS = new Set([
  'ObjectType',
  'InputType',
  'ArgsType',
  'InterfaceType',
])

const SKIP_PROPERTY_DECORATORS = new Set(['Field', 'HideField'])

function isConstObjectEnumDecl(decl: ts.VariableDeclaration): boolean {
  const initializer = decl.initializer
  if (!initializer) return false
  const literal = ts.isAsExpression(initializer)
    ? initializer.expression
    : initializer
  if (!ts.isObjectLiteralExpression(literal)) return false
  return (
    literal.properties.length > 0 &&
    literal.properties.every(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.initializer !== undefined &&
        ts.isStringLiteral(p.initializer),
    )
  )
}

function isEnumSymbol(symbol: ts.Symbol): boolean {
  for (const decl of symbol.declarations ?? []) {
    if (ts.isEnumDeclaration(decl)) return true
    if (ts.isVariableDeclaration(decl) && isConstObjectEnumDecl(decl))
      return true
  }
  return false
}

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

/**
 * Returns the class-level decorator name to inject based on filename and class
 * name conventions, or `undefined` if the class should not be auto-decorated.
 * Already-decorated classes are always skipped.
 *
 * Both `.args.ts` and `.input.ts` files support both suffixes — `*Args` always
 * maps to `@ArgsType()` and `*Input` always maps to `@InputType()`, regardless
 * of which extension the file uses.
 */
function getAutoClassDecorator(
  node: ts.ClassDeclaration,
  fileName: string,
  autoArgsType: boolean,
  autoInputType: boolean,
  autoObjectType: boolean,
): 'ArgsType' | 'InputType' | 'ObjectType' | undefined {
  if (isGraphQLClass(node)) return undefined
  const name = node.name?.text
  if (!name) return undefined
  if (fileName.endsWith('.args.ts') || fileName.endsWith('.input.ts')) {
    if (autoArgsType && name.endsWith('Args')) return 'ArgsType'
    if (autoInputType && name.endsWith('Input')) return 'InputType'
  }
  if (
    autoObjectType &&
    fileName.endsWith('.model.ts') &&
    name.endsWith('Model')
  )
    return 'ObjectType'
  return undefined
}

/**
 * Returns the set of class names that are explicitly exported from the given
 * source file. Used to determine whether a locally-defined class can be
 * referenced via `exports.ClassName` in _GRAPHQL_METADATA_FACTORY.
 */
function collectExportedClassNames(sourceFile: ts.SourceFile): Set<string> {
  const result = new Set<string>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue
    const mods = ts.getModifiers(stmt) ?? []
    if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      result.add(stmt.name.text)
    }
  }
  return result
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

type ImportedTypeEntry = {
  modulePath: string
  // Shared across all types from the same module — one require per module.
  namespaceIdent: ts.Identifier
  // Resolved relative path (no extension) for use in inline require() inside
  // _GRAPHQL_METADATA_FACTORY. Relative to the source file's directory.
  // Example: '../../share-class/dto/share-class.model'
  resolvedRelativePath?: string
}

/**
 * Scans the source file's named imports and returns a map of local name →
 * module entry for every import that is an enum OR a class. One namespaceIdent
 * is created per unique module so that a single `const __pid_types_N = require(...)`
 * statement covers all types from it.
 *
 * We scan ALL imports (including `import type`) because TypeScript import
 * elision is decided from the ORIGINAL source before `before` transformers run.
 * Any name that was only in a type position will have its import elided even if
 * our transformer adds a value-position reference. Using `require()` statements
 * bypasses the TypeScript import system entirely.
 */
function collectImportedTypeEntries(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Map<string, ImportedTypeEntry> {
  const result = new Map<string, ImportedTypeEntry>()
  const moduleIdents = new Map<string, ts.Identifier>()
  // Map from modulePath → resolvedRelativePath (computed once per module)
  const resolvedPaths = new Map<string, string | undefined>()

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const modulePath = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue

    for (const element of clause.namedBindings.elements) {
      const localName = element.name.text
      const sym = checker.getSymbolAtLocation(element.name)
      if (!sym) continue
      const resolved =
        sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
      if (!isEnumSymbol(resolved) && !(resolved.flags & ts.SymbolFlags.Class))
        continue

      if (!moduleIdents.has(modulePath)) {
        moduleIdents.set(modulePath, ts.factory.createUniqueName('__pid_types'))
      }

      // Compute resolved relative path (used for class types in metadata factory).
      if (!resolvedPaths.has(modulePath)) {
        const modSym = checker.getSymbolAtLocation(stmt.moduleSpecifier)
        const decl = modSym?.declarations?.[0]
        const targetFile = decl?.getSourceFile().fileName
        if (targetFile) {
          const sourceDir = path.dirname(sourceFile.fileName)
          const rel = path.relative(
            sourceDir,
            targetFile.replace(/\.tsx?$/, ''),
          )
          resolvedPaths.set(modulePath, rel.startsWith('.') ? rel : './' + rel)
        } else {
          resolvedPaths.set(modulePath, undefined)
        }
      }

      result.set(localName, {
        modulePath,
        namespaceIdent: moduleIdents.get(modulePath)!,
        resolvedRelativePath: resolvedPaths.get(modulePath),
      })
    }
  }

  return result
}

type TypeAnalysis = {
  isArray: boolean
  isNullable: boolean
  gqlScalar: string
  isEnum?: boolean
  // Set when the type is an enum imported from another module; the @Field
  // reference must go through a require() namespace to avoid TypeScript import
  // elision (elision is decided from the original source before transformers run).
  importedNsIdent?: ts.Identifier
  // When true, gqlScalar is a global JS constructor (String, Boolean, Date)
  // or a locally-defined class — use a bare identifier, not a namespace access.
  useGlobalIdent?: boolean
  // Set for ALL class type properties. Instead of a @Field() decorator
  // (which triggers emitDecoratorMetadata that can crash — either via import
  // elision for imported types, or via TDZ for locally-defined types declared
  // after the referencing class), the property is added to _GRAPHQL_METADATA_FACTORY
  // using a lazy arrow function — the same approach the official plugin uses.
  //   null   → locally-defined class: bare `() => ClassName` or `() => exports.ClassName`
  //   string → imported class: use inline require `() => require('path').ClassName`
  metadataModulePath?: string | null
  // When metadataModulePath is null (locally-defined class), this flag means the
  // class is exported and should be referenced via `exports.ClassName` instead of
  // a bare identifier. The `exports` object is never in TDZ, so this is safe even
  // when OmitType/PartialType calls the factory eagerly during module initialization
  // (before the class's `let` binding is initialized). Non-exported classes must
  // use the bare identifier; they're only TDZ-safe if defined before the referencing
  // class in the source file.
  metadataUseExports?: boolean
}

function resolveEnumName(
  inner: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): string | undefined {
  if (!ts.isIdentifier(inner.typeName)) return undefined
  const name = inner.typeName.text
  const symbol = checker.getSymbolAtLocation(inner.typeName)
  if (!symbol) return undefined
  if (isEnumSymbol(symbol)) return name
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol)
    if (isEnumSymbol(aliased)) return name
  }
  return undefined
}

function resolveClassName(
  inner: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): string | undefined {
  if (!ts.isIdentifier(inner.typeName)) return undefined
  const name = inner.typeName.text
  const symbol = checker.getSymbolAtLocation(inner.typeName)
  if (!symbol) {
    return undefined
  }
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol
  if (resolved.flags & ts.SymbolFlags.Class) return name
  return undefined
}

function analyzeType(
  typeNode: ts.TypeNode | undefined,
  isOptional: boolean,
  flavoredIdNames: Set<string>,
  sharedScalars: Map<string, string>,
  checker?: ts.TypeChecker,
  importedTypeEntries?: Map<string, ImportedTypeEntry>,
  exportedClassNames?: Set<string>,
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

  // Handle primitive keyword types: string → String, number → Float, boolean → Boolean.
  // These are global JS constructors; NestJS GraphQL maps them to GQL scalars.
  if (inner.kind === ts.SyntaxKind.StringKeyword) {
    return { isArray, isNullable, gqlScalar: 'String', useGlobalIdent: true }
  }
  if (inner.kind === ts.SyntaxKind.NumberKeyword) {
    // Default to Float (matches official @nestjs/graphql plugin default for number).
    // Use graphql namespace since Float IS exported from @nestjs/graphql.
    return { isArray, isNullable, gqlScalar: 'Float' }
  }
  if (inner.kind === ts.SyntaxKind.BooleanKeyword) {
    return { isArray, isNullable, gqlScalar: 'Boolean', useGlobalIdent: true }
  }

  if (!ts.isTypeReferenceNode(inner) || !ts.isIdentifier(inner.typeName)) {
    return undefined
  }

  const name = inner.typeName.text

  // Date is the native JS Date constructor; NestJS maps it to GraphQLISODateTime.
  if (name === 'Date') {
    return { isArray, isNullable, gqlScalar: 'Date', useGlobalIdent: true }
  }

  if (flavoredIdNames.has(name)) {
    return { isArray, isNullable, gqlScalar: 'ID' }
  }

  const gqlScalar = sharedScalars.get(name)
  if (gqlScalar !== undefined) {
    return { isArray, isNullable, gqlScalar }
  }

  if (checker) {
    const enumName = resolveEnumName(inner, checker)
    if (enumName) {
      const importedNsIdent = importedTypeEntries?.get(enumName)?.namespaceIdent
      return {
        isArray,
        isNullable,
        gqlScalar: enumName,
        isEnum: true,
        importedNsIdent,
      }
    }

    const className = resolveClassName(inner, checker)
    if (className) {
      const importedEntry = importedTypeEntries?.get(className)

      if (importedEntry) {
        // Imported class: adding @Field() would cause TypeScript's
        // emitDecoratorMetadata to reference the elided import namespace
        // (a known TypeScript issue). Use _GRAPHQL_METADATA_FACTORY with
        // inline require() instead — the same approach the official plugin uses.
        return {
          isArray,
          isNullable,
          gqlScalar: className,
          metadataModulePath:
            importedEntry.resolvedRelativePath ?? importedEntry.modulePath,
        }
      }
      // Locally-defined class: use _GRAPHQL_METADATA_FACTORY.
      // @Field() would cause emitDecoratorMetadata TDZ crashes when the class is
      // defined after the referencing class in the same file.
      //
      // For exported classes, use `exports.ClassName` — the `exports` object is
      // never in TDZ, so it's safe even when OmitType/PartialType calls the factory
      // eagerly during module load (before the class's `let` binding is initialized).
      // For non-exported classes, fall back to a bare identifier (safe as long as the
      // class is defined before the property that references it in the source file).
      const metadataUseExports = exportedClassNames?.has(className) ?? false
      return {
        isArray,
        isNullable,
        gqlScalar: className,
        metadataModulePath: null,
        metadataUseExports,
      }
    }
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

  let typeExpr: ts.Expression
  if (analysis.importedNsIdent) {
    // Imported type (enum or class): reference via require() namespace to prevent
    // TypeScript import elision (elision is decided before transformers run).
    typeExpr = ts.factory.createPropertyAccessExpression(
      analysis.importedNsIdent,
      ts.factory.createIdentifier(analysis.gqlScalar),
    )
  } else if (analysis.useGlobalIdent) {
    // Global JS constructor (String, Boolean, Date) or locally-defined class.
    typeExpr = ts.factory.createIdentifier(analysis.gqlScalar)
  } else {
    typeExpr = ts.factory.createPropertyAccessExpression(
      namespaceIdent,
      ts.factory.createIdentifier(analysis.gqlScalar),
    )
  }

  const typeRef = analysis.isArray
    ? ts.factory.createArrayLiteralExpression([typeExpr], false)
    : typeExpr

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

function createClassDecorator(
  decoratorName: string,
  namespaceIdent: ts.Identifier,
  typeName?: string,
): ts.Decorator {
  const args: ts.Expression[] = typeName
    ? [ts.factory.createStringLiteral(typeName)]
    : []
  return ts.factory.createDecorator(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        namespaceIdent,
        ts.factory.createIdentifier(decoratorName),
      ),
      undefined,
      args,
    ),
  )
}

type TransformState = {
  modified: boolean
  usedTypeNsIdents: Set<ts.Identifier>
  // Paths of imported class modules that need a top-level side-effect require()
  // so their @InputType()/@ObjectType() decorators run before NestJS schema compile().
  sideEffectRequirePaths: Set<string>
}

type MetadataFactoryEntry = {
  propertyName: string
  className: string
  modulePath: string | null // null = locally-defined, non-null = imported via require()
  // When modulePath is null: true = use exports.ClassName (for exported local classes),
  // false = use bare ClassName identifier (for non-exported local classes).
  useExports: boolean
  isArray: boolean
  isNullable: boolean
}

function buildMetadataFactoryMethod(
  entries: MetadataFactoryEntry[],
): ts.MethodDeclaration {
  const properties = entries.map((entry) => {
    // type: () => ClassName  |  exports.ClassName  |  require('path').ClassName
    let typeFn: ts.Expression
    if (entry.modulePath !== null) {
      // Imported class: require('path').ClassName
      typeFn = ts.factory.createPropertyAccessExpression(
        ts.factory.createCallExpression(
          ts.factory.createIdentifier('require'),
          undefined,
          [ts.factory.createStringLiteral(entry.modulePath)],
        ),
        ts.factory.createIdentifier(entry.className),
      )
    } else if (entry.useExports) {
      // Exported local class: exports.ClassName avoids TDZ when OmitType/PartialType
      // calls the factory eagerly before the class's `let` binding is initialized.
      typeFn = ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier('exports'),
        ts.factory.createIdentifier(entry.className),
      )
    } else {
      // Non-exported local class: bare identifier (safe when defined before use).
      typeFn = ts.factory.createIdentifier(entry.className)
    }

    const typeRef = entry.isArray
      ? ts.factory.createArrayLiteralExpression([typeFn], false)
      : typeFn

    const typeArrow = ts.factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      typeRef,
    )

    const fieldProps: ts.ObjectLiteralElementLike[] = [
      ts.factory.createPropertyAssignment('type', typeArrow),
    ]
    if (entry.isNullable) {
      fieldProps.push(
        ts.factory.createPropertyAssignment(
          'nullable',
          ts.factory.createTrue(),
        ),
      )
    }

    return ts.factory.createPropertyAssignment(
      ts.factory.createStringLiteral(entry.propertyName),
      ts.factory.createObjectLiteralExpression(fieldProps, false),
    )
  })

  return ts.factory.createMethodDeclaration(
    [ts.factory.createToken(ts.SyntaxKind.StaticKeyword)],
    undefined,
    ts.factory.createIdentifier('_GRAPHQL_METADATA_FACTORY'),
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createBlock(
      [
        ts.factory.createReturnStatement(
          ts.factory.createObjectLiteralExpression(properties, true),
        ),
      ],
      false,
    ),
  )
}

function transformClass(
  node: ts.ClassDeclaration,
  flavoredIdNames: Set<string>,
  sharedScalars: Map<string, string>,
  namespaceIdent: ts.Identifier,
  context: ts.TransformationContext,
  state: TransformState,
  autoDecorator: 'ArgsType' | 'InputType' | 'ObjectType' | undefined,
  checker?: ts.TypeChecker,
  importedTypeEntries?: Map<string, ImportedTypeEntry>,
  exportedClassNames?: Set<string>,
): ts.ClassDeclaration {
  const metadataFactoryEntries: MetadataFactoryEntry[] = []

  const propertyVisitor = (member: ts.Node): ts.Node => {
    if (!ts.isPropertyDeclaration(member)) return member
    if (hasSkipDecorator(member)) return member

    const analysis = analyzeType(
      member.type,
      member.questionToken !== undefined,
      flavoredIdNames,
      sharedScalars,
      checker,
      importedTypeEntries,
      exportedClassNames,
    )
    if (!analysis) return member

    // Class types: use _GRAPHQL_METADATA_FACTORY to avoid emitDecoratorMetadata
    // crashes caused by import elision (imported) or TDZ (locally-defined).
    if (
      analysis.metadataModulePath !== undefined &&
      ts.isIdentifier(member.name)
    ) {
      state.modified = true
      const modulePath = analysis.metadataModulePath
      metadataFactoryEntries.push({
        propertyName: member.name.text,
        className: analysis.gqlScalar,
        modulePath,
        useExports: analysis.metadataUseExports ?? false,
        isArray: analysis.isArray,
        isNullable: analysis.isNullable,
      })
      // Imported class type: ensure the module loads at app init so its
      // @InputType()/@ObjectType() decorator runs before compile() builds
      // typeDefinitionsStorage. Without this, the lazy require() inside
      // _GRAPHQL_METADATA_FACTORY executes after typeDefinitionsStorage
      // is already populated, causing "Cannot determine a GraphQL input type".
      if (modulePath !== null) {
        state.sideEffectRequirePaths.add(modulePath)
      }
      return member
    }
    // Locally-defined class types via @Field(): same file, no elision issue.
    // Basic primitives, IDs, scalars, enums: all safe via @Field().

    state.modified = true
    if (analysis.importedNsIdent) {
      state.usedTypeNsIdents.add(analysis.importedNsIdent)
    }
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

  let result = ts.visitEachChild(
    node,
    propertyVisitor,
    context,
  ) as ts.ClassDeclaration

  // Add _GRAPHQL_METADATA_FACTORY static method for imported class-type fields.
  if (metadataFactoryEntries.length > 0) {
    const factoryMethod = buildMetadataFactoryMethod(metadataFactoryEntries)
    result = ts.factory.updateClassDeclaration(
      result,
      result.modifiers,
      result.name,
      result.typeParameters,
      result.heritageClauses,
      ts.factory.createNodeArray([...result.members, factoryMethod]),
    )
  }

  if (autoDecorator) {
    state.modified = true
    const className = result.name?.text ?? ''
    const typeName =
      autoDecorator === 'ObjectType' && className.endsWith('Model')
        ? className.slice(0, -5)
        : undefined
    const classDecorator = createClassDecorator(
      autoDecorator,
      namespaceIdent,
      typeName,
    )
    result = ts.factory.updateClassDeclaration(
      result,
      [classDecorator, ...(result.modifiers ?? [])],
      result.name,
      result.typeParameters,
      result.heritageClauses,
      result.members,
    )
  }

  return result
}

function buildRequireStatement(
  namespaceIdent: ts.Identifier,
  modulePath: string,
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
            [ts.factory.createStringLiteral(modulePath)],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  )
}

function makeTransformer(
  options: PluginOptions | undefined,
  program: ts.Program | undefined,
): ts.TransformerFactory<ts.SourceFile> {
  const idModulePattern = new RegExp(
    options?.idModulePattern ?? DEFAULT_ID_MODULE_PATTERN.source,
  )
  const scalarModule = options?.scalarModule
  const scalars = options?.scalars
    ? new Map(Object.entries(options.scalars))
    : DEFAULT_SCALARS
  const autoArgsType = options?.autoArgsType ?? true
  const autoInputType = options?.autoInputType ?? true
  const autoObjectType = options?.autoObjectType ?? true
  const checker = program?.getTypeChecker()

  return (context) => (sourceFile) => {
    if (sourceFile.isDeclarationFile) return sourceFile

    const { fileName } = sourceFile
    const flavoredIdNames = collectFlavoredIdNames(sourceFile, idModulePattern)
    const sharedScalars = collectSharedScalars(
      sourceFile,
      scalarModule,
      scalars,
    )

    const mightAutoDecorate =
      ((autoArgsType || autoInputType) &&
        (fileName.endsWith('.args.ts') || fileName.endsWith('.input.ts'))) ||
      (autoObjectType && fileName.endsWith('.model.ts'))

    if (
      flavoredIdNames.size === 0 &&
      sharedScalars.size === 0 &&
      !mightAutoDecorate
    )
      return sourceFile

    const importedTypeEntries = checker
      ? collectImportedTypeEntries(sourceFile, checker)
      : new Map<string, ImportedTypeEntry>()
    const exportedClassNames = collectExportedClassNames(sourceFile)

    const namespaceIdent = ts.factory.createUniqueName('__pid_graphql')
    const state: TransformState = {
      modified: false,
      usedTypeNsIdents: new Set(),
      sideEffectRequirePaths: new Set(),
    }

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isClassDeclaration(node)) {
        const autoDecorator = getAutoClassDecorator(
          node,
          fileName,
          autoArgsType,
          autoInputType,
          autoObjectType,
        )
        if (isGraphQLClass(node) || autoDecorator !== undefined) {
          return transformClass(
            node,
            flavoredIdNames,
            sharedScalars,
            namespaceIdent,
            context,
            state,
            autoDecorator,
            checker,
            importedTypeEntries,
            exportedClassNames,
          )
        }
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

    // Add side-effect requires for imported class modules used in _GRAPHQL_METADATA_FACTORY.
    // This ensures those modules load during app initialization so their @InputType() /
    // @ObjectType() decorators run before NestJS's compile() populates typeDefinitionsStorage.
    for (const reqPath of state.sideEffectRequirePaths) {
      statements.splice(
        insertAt,
        0,
        ts.factory.createExpressionStatement(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier('require'),
            undefined,
            [ts.factory.createStringLiteral(reqPath)],
          ),
        ),
      )
      insertAt++
    }

    // Add one require() per imported type module that was actually used in a @Field().
    // These must come before the graphql namespace require so that type refs
    // are already bound when decorator expressions evaluate.
    const seenModulePaths = new Set<string>()
    for (const entry of importedTypeEntries.values()) {
      if (
        state.usedTypeNsIdents.has(entry.namespaceIdent) &&
        !seenModulePaths.has(entry.modulePath)
      ) {
        seenModulePaths.add(entry.modulePath)
        statements.splice(
          insertAt,
          0,
          buildRequireStatement(entry.namespaceIdent, entry.modulePath),
        )
        insertAt++
      }
    }

    statements.splice(
      insertAt,
      0,
      buildRequireStatement(namespaceIdent, '@nestjs/graphql'),
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
