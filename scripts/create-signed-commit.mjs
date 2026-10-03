import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      signature { isValid state }
    }
  }
}`;

const SUPPORTED_STATUSES = new Set(['A', 'M']);
const MAX_PAYLOAD_BYTES = 8_000_000;

export function parseNameStatusZ(text) {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 2 !== 0) {
    throw new Error('Malformed git diff --name-status -z output');
  }

  const additions = [];
  const deletions = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] ?? '';
    const path = parts[index + 1] ?? '';
    if (path.length === 0) throw new Error('Malformed git diff --name-status -z output');
    if (status === 'D') deletions.push(path);
    else if (SUPPORTED_STATUSES.has(status)) additions.push(path);
    else throw new Error(`Unsupported git status "${status}" for ${path}`);
  }
  return { additions, deletions };
}

export function collectWorkingTreeChanges(repoRoot, execFile = execFileSync) {
  const nameStatus = execFile('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const { additions, deletions } = parseNameStatusZ(nameStatus);
  const untracked = execFile('git', ['ls-files', '-o', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0);

  const seen = new Set(additions);
  for (const path of untracked) {
    if (!seen.has(path)) additions.push(path);
  }

  return {
    additions: additions.map((path) => ({
      path,
      contents: readFileSync(join(repoRoot, path)).toString('base64'),
    })),
    deletions: deletions.map((path) => ({ path })),
  };
}

export function buildCreateCommitOnBranchInput({ repository, branch, expectedHeadOid, headline, body, fileChanges }) {
  if (fileChanges.additions.length === 0 && fileChanges.deletions.length === 0) {
    throw new Error('No version changes to commit; aborting.');
  }
  if (headline.includes('\n')) throw new Error('Commit headline must be a single line');

  const message = { headline };
  if (body) message.body = body;

  const input = {
    branch: {
      repositoryNameWithOwner: repository,
      branchName: branch,
    },
    message,
    expectedHeadOid,
    fileChanges: {},
  };
  if (fileChanges.additions.length > 0) input.fileChanges.additions = fileChanges.additions;
  if (fileChanges.deletions.length > 0) input.fileChanges.deletions = fileChanges.deletions;
  return input;
}

export async function postCreateCommitOnBranch(
  input,
  { token, fetchImpl = globalThis.fetch, endpoint = 'https://api.github.com/graphql' } = {},
) {
  if (!token) throw new Error('GH_TOKEN is required to create a signed commit');
  const body = JSON.stringify({ query: MUTATION, variables: { input } });
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    throw new Error(`Signed commit payload is ${Buffer.byteLength(body)} bytes, above the GraphQL request limit`);
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body,
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const message =
      payload.errors?.map((error) => error.message).join('\n') || `${response.status} ${response.statusText}`;
    throw new Error(`Signed commit failed: ${message}`);
  }
  const commit = payload.data?.createCommitOnBranch?.commit;
  const oid = commit?.oid;
  if (!oid || commit?.signature?.isValid !== true) {
    throw new Error(`Signed commit failed: oid=${oid ?? 'missing'} signature=${commit?.signature?.state ?? 'missing'}`);
  }
  return oid;
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
  return value;
}

function optionalArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
  return value;
}

export function repositoryNameFromRemoteUrl(url) {
  const match = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error('Cannot determine repository from origin');
  return match[1];
}

function repositoryName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  return repositoryNameFromRemoteUrl(url);
}

async function main() {
  const branch = readArg('--branch');
  const headline = readArg('--headline');
  const body = optionalArg('--body');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const expectedHeadOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const fileChanges = collectWorkingTreeChanges(repoRoot);
  const input = buildCreateCommitOnBranchInput({
    repository: repositoryName(),
    branch,
    expectedHeadOid,
    headline,
    body,
    fileChanges,
  });
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const oid = await postCreateCommitOnBranch(input, { token });
  console.log(`Created signed commit ${oid} on ${branch}`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
