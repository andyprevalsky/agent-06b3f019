// Native lifecycle evidence only; never changes selection, retries or outcomes.
const fs = require('node:fs');
const path = require('node:path');
class SemanticReporter {
  onBegin(config, suite) {
    this.file = process.env.DEPLOY_SEMANTIC_LIFECYCLE;
    if (!this.file) throw new Error('Missing semantic lifecycle destination');
    this.root = config.rootDir;
    fs.writeFileSync(this.file, '', { flag: 'wx' });
    this.emit({ event: 'begin', tests: suite.allTests().map(test => ({
      id: test.id, project: test.parent.project().name,
      file: path.relative(config.rootDir, test.location.file).split(path.sep).join('/'),
      title: test.titlePath().slice(2),
    })) });
  }
  emit(row) { fs.appendFileSync(this.file, JSON.stringify(row) + '\n'); }
  onTestBegin(test, result) { this.emit({ event: 'testBegin', id: test.id, retry: result.retry }); }
  onStepEnd(test, result, step) {
    if (step.category === 'hook' && ['Before Hooks', 'After Hooks'].includes(step.title)) {
      this.emit({ event: 'hookEnd', id: test.id, retry: result.retry, title: step.title, ok: !step.error });
    }
  }
  onTestEnd(test, result) {
    this.emit({ event: 'testEnd', id: test.id, retry: result.retry, status: result.status });
  }
  onError() { this.emit({ event: 'globalError' }); }
  onEnd(result) { this.emit({ event: 'end', status: result.status }); }
}
module.exports = SemanticReporter;
