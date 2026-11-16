import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export interface InteractiveTransactionViolation {
  category: string;
  file: string;
  message: string;
  fix: string;
}

export interface RawInteractiveTransactionSite {
  file: string;
  scope: string;
  fingerprint: string;
  line: number;
}

interface AllowlistEntry {
  file: string;
  scope: string;
  fingerprint: string;
  reason: string;
}

// These calls predate runTransactionWithRetry or require Prisma options the
// wrapper does not expose. Each exception freezes the AST-discovered owning
// scope and a content fingerprint of the complete call. Moving, replacing, or
// editing a raw transaction therefore cannot hide beneath a file-level count.
const RAW_INTERACTIVE_TRANSACTION_ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'domains/agents/repoAgentMutations.ts',
    scope: 'replaceAgentTools',
    fingerprint: 'af6ef893c5ecfa8b',
    reason: 'legacy migration debt',
  },
  {
    file: 'domains/auth-assistance/repo.ts',
    scope: 'updateLiveViewHandoff',
    fingerprint: 'd2b826adb47d80a7',
    reason: 'legacy migration debt',
  },
  {
    file: 'domains/credential-propagation/repo.ts',
    scope: 'propagateCredentialInTransaction',
    fingerprint: 'aac2c3d9c497cb1b',
    reason: 'legacy migration debt',
  },
  {
    file: 'domains/purchases/repo.ts',
    scope: 'backfillLegacyCanonicalFingerprints',
    fingerprint: 'd0194dd6dd622935',
    reason: 'explicit 30-second advisory-lock policy',
  },
  {
    file: 'domains/purchases/repoSettlement.ts',
    scope: 'settlePurchaseAfterTransactionCleared',
    fingerprint: 'cd1cd0ea80d5cefb',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/benchmarkHubStore.base.ts',
    scope: 'withIndexLock',
    fingerprint: '19952f6e5ed95ad9',
    reason: 'immutable PR1480 original comparison; whole-file hash is checked by layer-deps',
  },
  {
    file: 'providers/benchmarkHubStore.ts',
    scope: 'withIndexLock',
    fingerprint: '34e5d3bbbfe61fd1',
    reason:
      'epoch-scoped advisory lock with SQL-budget cancellation/drain for bounded Hub publication cohorts; external conditional writes are not replayed by a SQL retry',
  },
  {
    file: 'providers/computeCredentials.ts',
    scope: 'tryAcquireLineageLease',
    fingerprint: 'fccedf4c20360763',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/credentialPropagation.ts',
    scope: 'propagateCredentialInTransaction',
    fingerprint: '05bc66f5ca14b307',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/credits.ts',
    scope: 'ensureInviteMonthlyCredit',
    fingerprint: '6f0b5e98a466dcd2',
    reason:
      'serializable isolation and whole-transaction retry are not exposed by the canonical wrapper',
  },
  {
    file: 'providers/database.ts',
    scope: 'runTransactionWithRetry',
    fingerprint: 'abc1f6000607a968',
    reason:
      'canonical wrapper implementation; caller deadline bounds acquisition/body and only pre-body failures retry',
  },
  {
    file: 'providers/database.ts',
    scope: 'runReadOnlyTransactionWithRetry',
    fingerprint: 'c3fdc39db28f7b2d',
    reason:
      'canonical read-only wrapper: SET TRANSACTION READ ONLY makes a mid-body replay write-free, so it retries Prisma DB errors after body entry, which runTransactionWithRetry deliberately refuses',
  },
  {
    file: 'providers/purchase-wallet-funding-repo.ts',
    scope: 'recordIssuedCardAndFunding',
    fingerprint: 'edde5882c2ca127a',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/smsSupervisor/proactiveOutreach.ts',
    scope: 'acquireJobLease',
    fingerprint: '221b2d0fafec1e53',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/smsSupervisor/proactiveOutreach.ts',
    scope: 'renewJobLease',
    fingerprint: '8ded8431ad196e59',
    reason: 'legacy migration debt',
  },
  {
    file: 'providers/traceArchiveFixture.ts',
    scope: 'collectFixtureSnapshot',
    fingerprint: '5e0daf8438d614b5',
    reason: 'repeatable-read isolation is not exposed by the canonical wrapper',
  },
  {
    file: 'providers/workflowDeploymentManifest.ts',
    scope: 'loadOrCreateWorkflowDeploymentManifest',
    fingerprint: '29bf8bac5cdd0f63',
    reason: 'legacy migration debt',
  },
];

function isTransactionCallee(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === '$transaction';
  if (ts.isElementAccessExpression(expression)) {
    return ts.isStringLiteral(expression.argumentExpression)
      ? expression.argumentExpression.text === '$transaction'
      : false;
  }
  return ts.isIdentifier(expression) && expression.text === '$transaction';
}

function isCallbackExpression(expression: ts.Expression | undefined): boolean {
  return (
    expression !== undefined &&
    (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
  );
}

function nodeName(node: ts.Node | undefined, sourceFile: ts.SourceFile): string | null {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText(sourceFile);
}

function enclosingScope(node: ts.Node, sourceFile: ts.SourceFile): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current)) {
      return nodeName(current.name, sourceFile) ?? '<anonymous-function>';
    }
    if (ts.isMethodDeclaration(current) || ts.isGetAccessor(current) || ts.isSetAccessor(current)) {
      return nodeName(current.name, sourceFile) ?? '<anonymous-method>';
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) {
        return nodeName(parent.name, sourceFile) ?? '<anonymous-callback>';
      }
      if (ts.isPropertyAssignment(parent)) {
        return nodeName(parent.name, sourceFile) ?? '<anonymous-callback>';
      }
    }
    current = current.parent;
  }
  return '<module>';
}

function fingerprintCall(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const normalized = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function findRawInteractiveTransactions(
  source: string,
  file = 'fixture.ts'
): RawInteractiveTransactionSite[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const sites: RawInteractiveTransactionSite[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      isTransactionCallee(node.expression) &&
      isCallbackExpression(node.arguments[0])
    ) {
      sites.push({
        file,
        scope: enclosingScope(node, sourceFile),
        fingerprint: fingerprintCall(node, sourceFile),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

function collectProductionTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'tests') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectProductionTsFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

function siteKey(
  site: Pick<RawInteractiveTransactionSite, 'file' | 'scope' | 'fingerprint'>
): string {
  return `${site.file}#${site.scope}@${site.fingerprint}`;
}

export function checkInteractiveTransactionPolicy(
  srcDir: string
): InteractiveTransactionViolation[] {
  const actual = collectProductionTsFiles(srcDir).flatMap((filePath) => {
    const file = path.relative(srcDir, filePath);
    return findRawInteractiveTransactions(fs.readFileSync(filePath, 'utf8'), file);
  });
  const exceptions = new Map(
    RAW_INTERACTIVE_TRANSACTION_ALLOWLIST.map((entry) => [siteKey(entry), entry])
  );
  const violations: InteractiveTransactionViolation[] = [];

  for (const site of actual) {
    const key = siteKey(site);
    const exception = exceptions.get(key);
    if (exception !== undefined) {
      exceptions.delete(key);
      continue;
    }
    violations.push({
      category: 'TRANSACTION POLICY VIOLATION',
      file: `${site.file}:${site.line}`,
      message: `Raw interactive $transaction in ${site.scope} has no exact exception (${site.fingerprint})`,
      fix: 'Use runTransactionWithRetry so timeout and safe transaction-start retry policy is consistent.',
    });
  }

  for (const exception of exceptions.values()) {
    violations.push({
      category: 'STALE TRANSACTION EXCEPTION',
      file: exception.file,
      message: `Exact exception no longer matches ${exception.scope}@${exception.fingerprint} (${exception.reason})`,
      fix: 'Remove the exception or migrate the edited call to runTransactionWithRetry.',
    });
  }
  return violations;
}
