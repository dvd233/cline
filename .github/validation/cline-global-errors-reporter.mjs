import fs from 'node:fs';

// Vitest 3.2.7's stock JSON reporter ignores its onFinished errors argument.
// This reporter only observes the completed native run; it changes no tests.
export default class GlobalErrorsReporter {
  result = { finished: false, ended: false, processTimeout: false };
  write() {
    if (!process.env.CLINE_ERRORS_FILE) throw new Error('Missing CLINE_ERRORS_FILE');
    fs.writeFileSync(process.env.CLINE_ERRORS_FILE, JSON.stringify(this.result, null, 2) + '\n');
  }
  errors(errors) {
    return errors.map(error => ({ name: error?.name, message: error?.message, stack: error?.stack, expected: error?.expected, actual: error?.actual }));
  }
  onFinished(files, errors) {
    const nonTestErrors = [];
    const testErrors = [];
    const visit = (task, titles = [], isFile = false) => {
      if (task.type === 'test' && task.result?.errors?.length) {
        testErrors.push({ fullName: [...titles, task.name].join(' '), errors: this.errors(task.result.errors) });
      }
      if (task.type !== 'test' && task.result?.errors?.length) {
        nonTestErrors.push({ name: task.name, errors: this.errors(task.result.errors) });
      }
      const nextTitles = isFile ? titles : [...titles, task.name];
      for (const child of task.tasks ?? []) visit(child, nextTitles);
    };
    for (const file of files) visit(file, [], true);
    Object.assign(this.result, {
      finished: true, files: files.length,
      finishedErrors: this.errors(errors), nonTestErrors, testErrors,
    });
    this.write();
  }
  onTestRunEnd(modules, errors, reason) {
    Object.assign(this.result, { ended: true, modules: modules.length, unhandledErrors: this.errors(errors), reason });
    this.write();
  }
  onProcessTimeout() {
    this.result.processTimeout = true;
    this.write();
  }
}
