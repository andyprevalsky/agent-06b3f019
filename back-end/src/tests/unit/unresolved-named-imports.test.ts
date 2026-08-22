import assert from 'assert';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');

/**
 * Catch named imports that the target module does not actually export.
 *
 * `tsconfig.json` includes only `src*` and excludes `src/tests*`, so NEITHER
 * `scripts/` nor `src/tests/` is in the typecheck program. A named import of a
 * symbol the target module never exported is therefore invisible to
 * `tsc --noEmit`: it silently evaluates to `undefined` at runtime.
 *
 * That is not hypothetical. `scripts/setup-benchmark-payment-guards.ts` imported
 * `BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID` from `src/domains/purchases/config`,
 * which never exported it (it lives in `src/providers/benchmarkPaymentIdentity`).
 * The constant was `undefined`, so `assertUserMatchesMode`'s sandbox branch compared
 * `userId !== undefined` — always true — and the guard silently never fired. Its job
 * is to refuse a sandbox provisioning run aimed at the PRODUCTION identity, which
 * would overwrite the live Stripe customer and AgentCard cardholder with sandbox
 * values. The same bad import appeared in `scripts/setup-benchmark-payment.ts` and
 * `src/tests/unit/setup-benchmark-payment-live-safety.test.ts`.
 *
 * Typechecking those directories outright would be the complete fix, but they carry
 * ~309 pre-existing type errors. This guard closes the specific dangerous class —
 * an import that resolves to `undefined` — without that cleanup.
 */

const SCAN_DIRS = ['scripts', 'src/tests'];
const SOURCE_EXT = new Set(['.ts', '.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve a relative specifier to a concrete file on disk, mirroring Node/tsx. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Names a module exports, read with TypeScript's own parser.
 *
 * Hand-rolled regexes are not good enough here: `export async function*`,
 * `export type { … }`, and multi-line export clauses each defeat the obvious
 * pattern and produce FALSE POSITIVES, which would make this guard worse than
 * useless. A module using `export *` is reported as wildcard and its importers
 * are skipped rather than guessed at.
 */
function collectExports(file: string): { names: Set<string>; wildcard: boolean } {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const names = new Set<string>();
  let wildcard = false;

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) {
        wildcard = true; // export * from '…'
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else {
        names.add(statement.exportClause.name.text); // export * as ns from '…'
      }
      continue;
    }
    if (!isExported(statement)) continue;

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        else {
          // Destructured export — bindings are not worth modelling; stay safe.
          wildcard = true;
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
  }
  return { names, wildcard };
}

const violations: string[] = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(backendDir, dir))) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const statement of source.statements) {
      // Named imports from a RELATIVE specifier only. Package imports are checked
      // through their shipped declarations and are not part of this gap.
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;

      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;

      const target = resolveModule(file, specifier);
      if (target === null) continue;
      const { names, wildcard } = collectExports(target);
      if (wildcard) continue;

      for (const element of bindings.elements) {
        // `import { a as b }` consumes the ORIGINAL name `a` from the target.
        const imported = (element.propertyName ?? element.name).text;
        if (!names.has(imported)) {
          violations.push(
            `${path.relative(backendDir, file)} imports '${imported}' from '${specifier}' ` +
              `(${path.relative(backendDir, target)}), which does not export it — ` +
              `it will be undefined at runtime.`
          );
        }
      }
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `Named imports that resolve to undefined at runtime:\n  ${violations.join('\n  ')}`
);

process.stdout.write(`PASS no unresolved named imports in ${SCAN_DIRS.join(', ')}\n`);
