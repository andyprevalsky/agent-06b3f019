/** Finish non-type-aware work before retaining a project's TypeScript Program. */
export async function lintInTypeOrder(eslint, files) {
  const plain = [];
  const typed = [];
  let inferSingleRun = true;
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    const options = config?.languageOptions?.parserOptions;
    if (options?.disallowAutomaticSingleRunInference) inferSingleRun = false;
    const target = options?.projectService || options?.project || options?.programs ? typed : plain;
    target.push(file);
  }
  // The old eslint CLI inferred a read-only single run from its executable path.
  // Preserve explicit operator overrides and config opt-outs in this API entry.
  const inferred = process.env.TSESTREE_SINGLE_RUN === undefined && inferSingleRun;
  if (inferred) process.env.TSESTREE_SINGLE_RUN = 'true';
  try {
    const results = [];
    for (const group of [plain, typed]) {
      if (group.length > 0) results.push(...await eslint.lintFiles(group));
    }
    return results;
  } finally {
    if (inferred) delete process.env.TSESTREE_SINGLE_RUN;
  }
}
