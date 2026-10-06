'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const bindings = require('./cline-slash-bindings.json');
const production = 'apps/vscode/webview-ui/src/utils/slash-commands.ts';
const testFile = 'apps/vscode/webview-ui/src/utils/__tests__/slash-commands.test.ts';
const focusedFilter = 'src/utils/__tests__/slash-commands.test.ts';
const output = path.resolve(process.env.VALIDATION_OUTPUT || 'cline-slash-validation');
const stages = [];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const blobSha = data => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const read = (root, file) => fs.readFileSync(path.join(root, file));
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function checkBindings(env = process.env, b = bindings) {
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REPOSITORY_ID, b.repository_id);
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, b.owner_id);
  assert.equal(env.GITHUB_REPOSITORY, b.source_repository);
  assert.equal(env.GITHUB_REF, b.validation_ref);
  assert.equal(b.source_repository, 'dvd233/cline');
  assert.equal(b.repository_id, '1407997359');
  assert.equal(b.owner_id, '111864431');
  assert.equal(b.validation_ref, 'refs/heads/validation/cline-slash-suffix-20261007');
  assert.equal(b.base_commit, 'b2c7148cd9286317875d46046efa9fd06caf7288');
  assert.equal(b.source_commit, '81c0e45a69359c6119aaee1ffddde5f5be02b621');
  assert.equal(b.base_tree, 'c630dde38001e849f54873640551bc74db4c39c1');
  assert.equal(b.source_tree, 'e5313efa1d6b4f48a420c7903416e9f96a5d224c');
  assert.equal(process.versions.node.split('.')[0], b.node_major);
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.error || result.signal}`);
  return result.stdout.trim();
}

function checkOriginalTests(baseText, candidateText) {
  const marker = 'describe("slash-commands", () => {\n';
  const next = '\tdescribe("getMcpPromptCommands", () => {\n';
  const start = candidateText.indexOf(marker) + marker.length;
  assert(start >= marker.length);
  const end = candidateText.indexOf(next, start);
  assert(end > start && baseText.includes(marker + next));
  let restored = candidateText.slice(0, start) + candidateText.slice(end);
  const oldImport = 'import { getMatchingSlashCommands, getMcpPromptCommands, slashCommandRegex, validateSlashCommand } from "../slash-commands"';
  const newImport = 'import {\n\tgetMatchingSlashCommands,\n\tgetMcpPromptCommands,\n\tremoveSlashCommand,\n\tslashCommandRegex,\n\tvalidateSlashCommand,\n} from "../slash-commands"';
  assert.equal(restored.split(newImport).length, 2);
  restored = restored.replace(newImport, oldImport);
  assert.equal(restored, baseText, 'Existing 22 tests were modified');
}

function checkContents(base, candidate, b = bindings) {
  for (const change of b.changes) {
    const before = read(base, change.path);
    const after = read(candidate, change.path);
    assert.equal(blobSha(before), change.base_blob_sha, `Baseline blob mismatch: ${change.path}`);
    assert.equal(blobSha(after), change.candidate_blob_sha, `Candidate blob mismatch: ${change.path}`);
    assert.equal(sha256(after), change.candidate_sha256);
  }
  const before = read(base, production).toString('utf8');
  const after = read(candidate, production).toString('utf8');
  const from = 'afterCursor.replace(" ", "") // removes the first space after the command';
  const to = 'afterCursor.replace(/^ /, "") // removes the space immediately after the command';
  assert.equal(before.split(from).length, 2);
  assert.equal(after, before.replace(from, to), 'Production change widened');
  checkOriginalTests(read(base, testFile).toString('utf8'), read(candidate, testFile).toString('utf8'));
  for (const [file, expected] of Object.entries(b.unchanged_files)) {
    assert.equal(sha256(read(base, file)), expected, `Baseline guard changed: ${file}`);
    assert.equal(sha256(read(candidate, file)), expected, `Candidate guard changed: ${file}`);
  }
}

function checkCheckouts(base, candidate) {
  assert.equal(git(base, 'rev-parse', 'HEAD'), bindings.base_commit);
  assert.equal(git(base, 'rev-parse', 'HEAD^{tree}'), bindings.base_tree);
  assert.equal(git(candidate, 'rev-parse', 'HEAD'), bindings.source_commit);
  assert.equal(git(candidate, 'rev-parse', 'HEAD^{tree}'), bindings.source_tree);
  assert.equal(git(candidate, 'show', '-s', '--format=%P', 'HEAD'), bindings.base_commit, 'Source must have exactly the verified base parent');
  const changed = git(candidate, 'diff', '--name-status', bindings.base_commit, 'HEAD').split('\n').sort();
  assert.deepEqual(changed, [`M\t${production}`, `M\t${testFile}`].sort());
  checkContents(base, candidate);
  for (const root of [base, candidate]) {
    assert.equal(git(root, 'diff', '--name-only', 'HEAD'), '', 'Checkout initially dirty');
    // The official formatting script compares against a local main ref.
    git(root, 'update-ref', 'refs/heads/main', bindings.base_commit);
  }
}

function runStage(label, cwd, command, args, env = {}, timeout = 1200000) {
  const log = path.join(output, `${label}.log`);
  const fd = fs.openSync(log, 'w');
  const started = new Date().toISOString();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout,
    });
  } catch (error) { result = { status: null, signal: null, error }; }
  finally { fs.closeSync(fd); }
  const stage = { label, cwd, command, args, started, finished: new Date().toISOString(),
    exit: result.status, signal: result.signal, error: result.error ? String(result.error) : null, log };
  stages.push(stage);
  writeJSON(path.join(output, `${label}.status.json`), stage);
  console.log(JSON.stringify(stage));
  return stage;
}
function skipStage(label, reason) {
  const stage = { label, skipped: true, reason, exit: null };
  stages.push(stage);
  fs.writeFileSync(path.join(output, `${label}.log`), `NOT RUN: ${reason}\n`);
  writeJSON(path.join(output, `${label}.status.json`), stage);
  return stage;
}
function completed(stage) { return Boolean(stage) && stage.exit === 0 && !stage.signal && !stage.error && !stage.skipped; }
function nativeTest(label, root, filter) {
  const report = path.join(output, `${label}.json`);
  const errors = path.join(output, `${label}.errors.json`);
  return runStage(label, path.join(root, 'apps/vscode/webview-ui'), 'bun',
    ['run', 'test', ...(filter ? [filter] : []), '--reporter=default', '--reporter=json',
      `--reporter=${path.join(__dirname, 'cline-global-errors-reporter.mjs')}`, `--outputFile=${report}`],
    { CLINE_ERRORS_FILE: errors });
}
function checkNoRuntimeErrors(global, expectedReason) {
  assert.equal(global.finished, true, 'Native onFinished observation missing');
  assert.equal(global.ended, true, 'Native onTestRunEnd observation missing');
  assert.equal(global.processTimeout, false);
  assert.equal(global.reason, expectedReason);
  assert.deepEqual(global.finishedErrors, []);
  assert.deepEqual(global.unhandledErrors, []);
  assert.deepEqual(global.nonTestErrors, []);
}
function assertions(report) {
  assert(Array.isArray(report.testResults) && report.testResults.length > 0);
  for (const file of report.testResults) assert.equal(file.message, '', `File-level error: ${file.name}`);
  const all = report.testResults.flatMap(file => file.assertionResults);
  assert(all.length > 0, 'Zero collected native tests');
  assert.equal(report.numTotalTests, all.length);
  return all;
}
function checkFocused(report, global, stage, expectedCount) {
  assert(completed(stage));
  checkNoRuntimeErrors(global, 'passed');
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  const all = assertions(report);
  assert.equal(all.length, expectedCount);
  assert(all.every(test => test.status === 'passed'));
}
function checkNegative(report, global, stage, references) {
  assert.equal(stage.exit, 1, 'Negative control must exit exactly 1');
  assert(!stage.signal && !stage.error && !stage.skipped);
  checkNoRuntimeErrors(global, 'failed');
  assert.equal(report.success, false);
  assert.equal(report.testResults.length, 1);
  assert.equal(report.numTotalTests, 30);
  assert.equal(report.numFailedTests, 4);
  assert.equal(report.numPassedTests, 26);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  const all = assertions(report);
  assert.equal(all.length, 30);
  assert(all.every(test => ['passed', 'failed'].includes(test.status)));
  const expected = [
    ...['\nhello world', '\r\nhello world', '\n  hello world'].map(suffix =>
      `slash-commands removeSlashCommand preserves following-line whitespace in ${JSON.stringify(suffix)}`),
    'slash-commands removeSlashCommand preserves the prefix and following-line text for a command in the middle',
  ].sort();
  const failed = all.filter(test => test.status === 'failed');
  assert.deepEqual(failed.map(test => test.fullName).sort(), expected);
  assert(references && typeof references === 'object', 'Exact native error serialization reference missing');
  assert.equal(global.testErrors.length, 4);
  assert.deepEqual(global.testErrors.map(test => test.fullName).sort(), expected);
  for (const record of global.testErrors) {
    assert.equal(record.errors.length, 1);
    const error = record.errors[0];
    assert.equal(error.name, 'AssertionError');
    assert.equal(typeof error.actual, 'string');
    assert.equal(typeof error.expected, 'string');
    assert.equal(error.actual, references[record.fullName].actual, 'Wrong actual text/cursor object');
    assert.equal(error.expected, references[record.fullName].expected, 'Wrong expected text/cursor object');
  }
  for (const test of failed) {
    assert.deepEqual(test.ancestorTitles, ['slash-commands', 'removeSlashCommand']);
    assert(Array.isArray(test.failureMessages) && test.failureMessages.length > 0);
    assert(test.failureMessages.every(message => /AssertionError/.test(message)), 'Failure is not an assertion error');
  }
}
function testArtifact(label) {
  return [JSON.parse(fs.readFileSync(path.join(output, `${label}.json`))),
    JSON.parse(fs.readFileSync(path.join(output, `${label}.errors.json`)))];
}
function expectedAddedNames() {
  return [
    ...['\nhello world', '\r\nhello world', '\n  hello world'].map(suffix =>
      `slash-commands removeSlashCommand preserves following-line whitespace in ${JSON.stringify(suffix)}`),
    'slash-commands removeSlashCommand preserves the prefix and following-line text for a command in the middle',
    ...['/newtask hello world', '/newtask  hello world'].map(text =>
      `slash-commands removeSlashCommand removes only the immediately following space from ${JSON.stringify(text)}`),
    'slash-commands removeSlashCommand removes a command at the end of the input',
    'slash-commands removeSlashCommand leaves text without a command at the cursor unchanged',
  ];
}
function fullSuiteRows(report, root) {
  assertions(report);
  return report.testResults.flatMap(file => {
    const relative = path.relative(root, file.name).split(path.sep).join('/');
    assert(!relative.startsWith('../') && !path.isAbsolute(relative), 'Test file is outside its source checkout');
    return file.assertionResults.map(test => ({ file: relative, name: test.fullName, status: test.status }));
  });
}
function countRows(rows) {
  const counts = new Map();
  for (const row of rows) { const key = JSON.stringify(row); counts.set(key, (counts.get(key) || 0) + 1); }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
function compareFullSuites(baseReport, candidateReport, baseRoot, candidateRoot) {
  const baseline = fullSuiteRows(baseReport, baseRoot);
  const candidate = fullSuiteRows(candidateReport, candidateRoot);
  const additions = expectedAddedNames().map(name => ({ file: testFile, name, status: 'passed' }));
  const comparison = { baselineCount: baseline.length, candidateCount: candidate.length, expectedAdded: additions,
    baselineIdentityStatus: countRows(baseline), candidateIdentityStatus: countRows(candidate) };
  assert.deepEqual(countRows(candidate), countRows([...baseline, ...additions]),
    'Full suites must preserve every original test identity and status, including skipped/todo tests, and add only the eight approved passed regressions');
  return comparison;
}
function makeNegativeReferences(processError) {
  const pairs = [
    ['\nhello world', '\nhelloworld', 0],
    ['\r\nhello world', '\r\nhelloworld', 0],
    ['\n  hello world', '\n hello world', 0],
    ['Please \nhello world', 'Please \nhelloworld', 7],
  ];
  return Object.fromEntries(pairs.map(([expected, actual, newPosition], index) => {
    const error = processError({ name: 'AssertionError', showDiff: false,
      expected: { newText: expected, newPosition }, actual: { newText: actual, newPosition } });
    assert.equal(typeof error.expected, 'string');
    assert.equal(typeof error.actual, 'string');
    return [expectedAddedNames()[index], { expected: error.expected, actual: error.actual }];
  }));
}
async function nativeNegativeReferences(candidate) {
  const webRequire = createRequire(path.join(candidate, 'apps/vscode/webview-ui/package.json'));
  const vitestPackage = webRequire.resolve('vitest/package.json');
  assert.equal(JSON.parse(fs.readFileSync(vitestPackage)).version, '3.2.7');
  const vitestRequire = createRequire(vitestPackage);
  const modulePath = vitestRequire.resolve('@vitest/utils/error');
  let directory = path.dirname(modulePath);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory); assert.notEqual(parent, directory); directory = parent;
  }
  const utilsPackage = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  assert.equal(utilsPackage.name, '@vitest/utils');
  assert.equal(utilsPackage.version, '3.2.7');
  const { processError } = await import(pathToFileURL(modulePath).href);
  const references = makeNegativeReferences(processError);
  writeJSON(path.join(output, 'negative-serialization-reference.json'), { vitest: '3.2.7', utils: utilsPackage.version, references });
  return references;
}
function stageCheck(label, fn) {
  try { fn(); writeJSON(path.join(output, `${label}.json`), { passed: true }); return true; }
  catch (error) { writeJSON(path.join(output, `${label}.json`), { passed: false, error: String(error), stack: error.stack }); return false; }
}

async function run(base, candidate) {
  checkCheckouts(base, candidate);
  writeJSON(path.join(output, 'source-bindings-verified.json'), bindings);
  const lanes = {};
  for (const [name, root] of [['baseline', base], ['candidate', candidate]]) {
    const install = runStage(`${name}-install`, root, 'bun', ['install', '--frozen-lockfile']);
    const lane = lanes[name] = { root, install };
    if (!completed(install)) {
      for (const phase of ['versions', 'sqlite', 'sdk-build', 'quality', 'webview-build', 'full-webview', 'focused']) lane[phase] = skipStage(`${name}-${phase}`, 'Frozen installation failed');
      continue;
    }
    lane.versions = runStage(`${name}-versions`, path.join(root, 'apps/vscode/webview-ui'), process.execPath,
      ['-e', `const a=require('node:assert/strict');a.equal(require('vitest/package.json').version,'3.2.7');console.log({node:process.version,vitest:require('vitest/package.json').version});`]);
    lane.sqlite = runStage(`${name}-sqlite`, root, process.execPath, ['-e',
      `const fs=require('node:fs'); const p='apps/vscode/node_modules/better-sqlite3/build/Release/better_sqlite3.node';if(!fs.existsSync(p))throw new Error('Required native binary absent: '+p);console.log(p);`]);
    lane.build = runStage(`${name}-sdk-build`, root, 'bun', ['run', 'build:sdk']);
    lane.quality = runStage(`${name}-quality`, path.join(root, 'apps/vscode'), 'bun', ['run', 'ci:check-all']);
    lane.webviewBuild = runStage(`${name}-webview-build`, path.join(root, 'apps/vscode/webview-ui'), 'bun', ['run', 'build']);
    lane.full = nativeTest(`${name}-full-webview`, root);
    lane.focused = nativeTest(`${name}-focused`, root, focusedFilter);
  }
  let negative;
  if (completed(lanes.candidate.install)) {
    const current = read(candidate, production);
    try {
      fs.writeFileSync(path.join(candidate, production), read(base, production));
      negative = nativeTest('negative-focused', candidate, focusedFilter);
    } finally { fs.writeFileSync(path.join(candidate, production), current); }
  } else negative = skipStage('negative-focused', 'Candidate installation failed');
  const verdicts = {};
  verdicts.baselineFocused = stageCheck('baseline-focused-verdict', () => checkFocused(...testArtifact('baseline-focused'), lanes.baseline.focused, 22));
  verdicts.candidateFocused = stageCheck('candidate-focused-verdict', () => checkFocused(...testArtifact('candidate-focused'), lanes.candidate.focused, 30));
  let references;
  try { references = await nativeNegativeReferences(candidate); }
  catch (error) { writeJSON(path.join(output, 'negative-serialization-error.json'), { error: String(error) }); }
  verdicts.negative = stageCheck('negative-focused-verdict', () => checkNegative(...testArtifact('negative-focused'), negative, references));
  for (const name of ['baseline', 'candidate']) {
    verdicts[`${name}Full`] = stageCheck(`${name}-full-verdict`, () => {
      assert(completed(lanes[name].full));
      const [report, global] = testArtifact(`${name}-full-webview`);
      checkNoRuntimeErrors(global, 'passed');
      assert.equal(report.success, true);
      assertions(report);
      assert.equal(report.numFailedTests, 0);
    });
  }
  verdicts.fullComparison = stageCheck('full-suite-comparison', () => {
    const comparison = compareFullSuites(testArtifact('baseline-full-webview')[0], testArtifact('candidate-full-webview')[0], base, candidate);
    writeJSON(path.join(output, 'full-suite-comparison-details.json'), comparison);
  });
  verdicts.finalSource = stageCheck('final-source-verdict', () => {
    checkContents(base, candidate);
    assert.equal(git(base, 'diff', '--name-only', 'HEAD'), '', 'Baseline tracked source changed during validation');
    assert.equal(git(candidate, 'diff', '--name-only', 'HEAD'), '', 'Candidate tracked source changed during validation');
  });
  const required = stages.filter(stage => stage.label !== 'negative-focused');
  const passed = required.every(completed) && Object.values(verdicts).every(Boolean);
  writeJSON(path.join(output, 'summary.json'), { passed, verdicts, stages,
    scope: 'Original-lock SDK build, extension quality scripts, webview TypeScript/Vite production build, complete webview tests, focused baseline/candidate and negative control; no extension-host/Electron/e2e/CLI/daemon/model/account execution.' });
  if (!passed) process.exitCode = 1;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  checkBindings();
  writeJSON(path.join(output, 'binding-check.json'), { passed: true, bindings });
  if (process.argv[2] === 'check-bindings') return;
  assert.equal(process.argv[2], 'run');
  const bun = runStage('bun-version', process.cwd(), 'bun', ['--version']);
  assert(completed(bun));
  assert.equal(fs.readFileSync(bun.log, 'utf8').trim(), bindings.bun_version);
  await run(path.resolve(process.argv[3]), path.resolve(process.argv[4]));
}
if (require.main === module) {
  main().catch(error => {
    fs.mkdirSync(output, { recursive: true });
    writeJSON(path.join(output, 'fatal.json'), { error: String(error), stack: error.stack, stages });
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { checkBindings, checkOriginalTests, checkContents, checkNoRuntimeErrors, checkNegative, checkFocused, compareFullSuites, expectedAddedNames, makeNegativeReferences, sha256, blobSha };
