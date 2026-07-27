import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const supervisorPath = fileURLToPath(new URL('./runtime_log_soak_supervisor.mjs', import.meta.url));

function runSupervisor(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [supervisorPath, '--supervise', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

test('supervisor writes a terminal crash artifact when its soak child exits unexpectedly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-runtime-log-soak-supervisor-'));
  const artifactPath = join(root, 'supervisor.json');
  const childArtifactPath = join(root, 'child.json');
  const logPath = join(root, 'runtime.log');
  try {
    const result = await runSupervisor([
      '--duration-ms=1000',
      '--interval-ms=5',
      '--max-bytes=4096',
      '--max-age-ms=1000',
      '--max-files=2',
      `--artifact=${artifactPath}`,
      `--child-artifact=${childArtifactPath}`,
      `--log-path=${logPath}`,
      '--test-crash-after-writes=1',
    ]);

    assert.equal(result.signal, null, result.stderr);
    assert.notEqual(result.code, 0, result.stdout);
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    assert.equal(artifact.status, 'child_crashed');
    assert.equal(artifact.finishedAt !== null, true);
    assert.equal(artifact.child.exitCode, 97);
    assert.equal(artifact.childArtifactPath, childArtifactPath);
    assert.equal(artifact.crashEvidence.truncated, false);
    assert.ok(Array.isArray(artifact.crashEvidence.lines));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
