import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCreateCommitOnBranchInput,
  collectWorkingTreeChanges,
  parseNameStatusZ,
  postCreateCommitOnBranch,
  repositoryNameFromRemoteUrl,
} from './create-signed-commit.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

describe('create-signed-commit', () => {
  it('parses NUL name-status records and rejects renames', () => {
    assert.deepEqual(parseNameStatusZ('M\0packages/core/package.json\0D\0.changeset/gone.md\0A\0extra.txt\0'), {
      additions: ['packages/core/package.json', 'extra.txt'],
      deletions: ['.changeset/gone.md'],
    });
    assert.deepEqual(parseNameStatusZ(''), { additions: [], deletions: [] });
    assert.throws(() => parseNameStatusZ('R100\0old\0new\0'), /Malformed git diff/);
    assert.throws(() => parseNameStatusZ('T\0link\0'), /Unsupported git status "T"/);
    assert.throws(() => parseNameStatusZ('M\0'), /Malformed git diff/);
  });

  it('collects working tree edits, deletions, and untracked files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tslock-signed-commit-'));
    try {
      git(repo, ['init']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);
      writeFileSync(join(repo, 'keep.txt'), 'before\n');
      writeFileSync(join(repo, 'gone.txt'), 'delete-me\n');
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
      git(repo, ['add', 'keep.txt', 'gone.txt', '.gitignore']);
      git(repo, ['commit', '-m', 'init']);
      writeFileSync(join(repo, 'keep.txt'), 'after\n');
      writeFileSync(join(repo, 'my file.txt'), 'new\n');
      writeFileSync(join(repo, 'ignored.txt'), 'secret\n');
      rmSync(join(repo, 'gone.txt'));

      const changes = collectWorkingTreeChanges(repo);
      assert.deepEqual(changes.additions.map((file) => file.path).sort(), ['keep.txt', 'my file.txt']);
      assert.equal(
        changes.additions.find((file) => file.path === 'keep.txt')?.contents,
        Buffer.from('after\n').toString('base64'),
      );
      assert.deepEqual(changes.deletions, [{ path: 'gone.txt' }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('builds a bot commit input with no author, committer, or signature', () => {
    const input = buildCreateCommitOnBranchInput({
      repository: 'drmaas/tslock',
      branch: 'release/v2.1.2',
      expectedHeadOid: 'abc',
      headline: 'chore: release v2.1.2',
      fileChanges: {
        additions: [{ path: 'packages/core/package.json', contents: 'e30=' }],
        deletions: [],
      },
    });
    assert.equal(input.branch.branchName, 'release/v2.1.2');
    assert.equal(input.expectedHeadOid, 'abc');
    assert.equal(input.message.headline, 'chore: release v2.1.2');
    assert.equal(input.message.body, undefined);
    assert.deepEqual(input.fileChanges.additions, [{ path: 'packages/core/package.json', contents: 'e30=' }]);
    assert.equal(input.fileChanges.deletions, undefined);
    assert.equal(input.author, undefined);
    assert.equal(input.committer, undefined);
    assert.equal(input.signature, undefined);
    assert.throws(
      () =>
        buildCreateCommitOnBranchInput({
          repository: 'drmaas/tslock',
          branch: 'release/v2.1.2',
          expectedHeadOid: 'abc',
          headline: 'chore: release v2.1.2',
          fileChanges: { additions: [], deletions: [] },
        }),
      /No version changes to commit/,
    );
  });

  it('posts the mutation with the token and surfaces GraphQL errors', async () => {
    const requests = [];
    const oid = await postCreateCommitOnBranch(
      { branch: { repositoryNameWithOwner: 'drmaas/tslock', branchName: 'release/v2.1.2' } },
      {
        token: 'test-token',
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
              data: {
                createCommitOnBranch: { commit: { oid: 'deadbeef', signature: { isValid: true, state: 'VALID' } } },
              },
            }),
          };
        },
      },
    );
    assert.equal(oid, 'deadbeef');
    assert.equal(requests[0]?.init.headers.Authorization, 'Bearer test-token');
    const sent = JSON.parse(requests[0]?.init.body ?? '{}');
    assert.equal(sent.variables.input.author, undefined);
    assert.match(sent.query, /createCommitOnBranch/);

    await assert.rejects(() => postCreateCommitOnBranch({}, {}), /GH_TOKEN is required/);
    await assert.rejects(
      () =>
        postCreateCommitOnBranch(
          {},
          {
            token: 'test-token',
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => ({
                data: {
                  createCommitOnBranch: {
                    commit: { oid: 'deadbeef', signature: { isValid: false, state: 'UNSIGNED' } },
                  },
                },
              }),
            }),
          },
        ),
      /signature=UNSIGNED/,
    );
    await assert.rejects(
      () =>
        postCreateCommitOnBranch(
          {},
          {
            token: 'test-token',
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: async () => ({ errors: [{ message: 'expected head oid mismatch' }] }),
            }),
          },
        ),
      /expected head oid mismatch/,
    );
  });

  it('reads the owner and repo from an origin URL without keeping credentials', () => {
    assert.equal(repositoryNameFromRemoteUrl('https://github.com/drmaas/tslock'), 'drmaas/tslock');
    assert.equal(repositoryNameFromRemoteUrl('git@github.com:drmaas/tslock.git'), 'drmaas/tslock');
    assert.equal(repositoryNameFromRemoteUrl('https://user:placeholder@github.com/drmaas/tslock'), 'drmaas/tslock');
    assert.throws(
      () => repositoryNameFromRemoteUrl('https://example.com/drmaas/tslock'),
      /Cannot determine repository/,
    );
  });

  it('release workflow creates the release commit through the signed-commit script', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    const prepare = workflow.split('  publish:')[0] ?? '';
    const branchRef = '$' + '{branch}';
    const pushAt = prepare.indexOf(`git push -u origin "HEAD:refs/heads/${branchRef}" --force`);
    const commitAt = prepare.indexOf('node scripts/create-signed-commit.mjs --branch "$branch" --headline "$title"');
    assert.ok(pushAt !== -1 && commitAt !== -1 && pushAt < commitAt);
    assert.doesNotMatch(prepare, /\bgit commit\b/);
    assert.doesNotMatch(prepare, /user\.email/);
  });
});
