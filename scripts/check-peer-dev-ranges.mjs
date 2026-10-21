import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*|X)(?:\.(\d+|x|\*|X))?(?:\.(\d+|x|\*|X))?$/;

function unbounded() {
  return { min: null, minInclusive: true, max: null, maxInclusive: false };
}

function parseComponent(value) {
  if (value === undefined) return 'missing';
  if (value === 'x' || value === 'X' || value === '*') return 'wild';
  return Number(value);
}

function partsFromMatch(match) {
  const major = parseComponent(match[2]);
  const minor = parseComponent(match[3]);
  const patch = parseComponent(match[4]);
  if (major === 'wild') {
    if (minor !== 'missing' || patch !== 'missing') return null;
    return { major: 'wild', minor: 'wild', patch: 'wild' };
  }
  if (minor === 'wild') {
    if (patch !== 'missing') return null;
    return { major, minor: 'wild', patch: 'wild' };
  }
  if (patch === 'wild') {
    if (minor === 'missing') return null;
    return { major, minor, patch: 'wild' };
  }
  return { major, minor, patch };
}

function isSpecified(component) {
  return component !== 'missing' && component !== 'wild';
}

function filled(parts) {
  return [
    parts.major === 'wild' ? 0 : parts.major,
    isSpecified(parts.minor) ? parts.minor : 0,
    isSpecified(parts.patch) ? parts.patch : 0,
  ];
}

function caretInterval(parts) {
  if (parts.major === 'wild') return unbounded();
  const min = filled(parts);
  const minorSpecified = isSpecified(parts.minor);
  const patchSpecified = isSpecified(parts.patch);
  const minor = minorSpecified ? parts.minor : 0;
  let max;
  if (parts.major > 0 || !minorSpecified) {
    max = [parts.major + 1, 0, 0];
  } else if (minor > 0 || !patchSpecified) {
    max = [parts.major, minor + 1, 0];
  } else {
    max = [parts.major, minor, (patchSpecified ? parts.patch : 0) + 1];
  }
  return { min, minInclusive: true, max, maxInclusive: false };
}

function tildeInterval(parts) {
  if (parts.major === 'wild') return unbounded();
  const min = filled(parts);
  const max = isSpecified(parts.minor) ? [parts.major, parts.minor + 1, 0] : [parts.major + 1, 0, 0];
  return { min, minInclusive: true, max, maxInclusive: false };
}

function xRangeInterval(parts) {
  if (parts.major === 'wild') return unbounded();
  if (!isSpecified(parts.minor)) {
    return { min: [parts.major, 0, 0], minInclusive: true, max: [parts.major + 1, 0, 0], maxInclusive: false };
  }
  if (!isSpecified(parts.patch)) {
    return {
      min: [parts.major, parts.minor, 0],
      minInclusive: true,
      max: [parts.major, parts.minor + 1, 0],
      maxInclusive: false,
    };
  }
  const version = [parts.major, parts.minor, parts.patch];
  return { min: version, minInclusive: true, max: version, maxInclusive: true };
}

function comparatorInterval(operator, parts) {
  if (parts.major === 'wild' || parts.minor === 'wild' || parts.patch === 'wild') return null;
  const version = filled(parts);
  if (operator === '>=') return { min: version, minInclusive: true, max: null, maxInclusive: false };
  if (operator === '>') return { min: version, minInclusive: false, max: null, maxInclusive: false };
  if (operator === '<=') return { min: null, minInclusive: true, max: version, maxInclusive: true };
  if (operator === '<') return { min: null, minInclusive: true, max: version, maxInclusive: false };
  if (operator === '=') return { min: version, minInclusive: true, max: version, maxInclusive: true };
  return null;
}

function parseComparator(token) {
  if (token === '*' || token === 'x' || token === 'X') return unbounded();
  const match = COMPARATOR.exec(token);
  if (!match) return null;
  const parts = partsFromMatch(match);
  if (!parts) return null;
  const operator = match[1] ?? '';
  if (operator === '^') return caretInterval(parts);
  if (operator === '~') return tildeInterval(parts);
  if (operator === '') return xRangeInterval(parts);
  return comparatorInterval(operator, parts);
}

function cmpVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function endsBefore(end, endInclusive, start, startInclusive) {
  const order = cmpVersion(end, start);
  if (order < 0) return true;
  if (order > 0) return false;
  return !(endInclusive && startInclusive);
}

function higherLowerBound(left, right) {
  if (!left.min) return { min: right.min, minInclusive: right.minInclusive };
  if (!right.min) return { min: left.min, minInclusive: left.minInclusive };
  const order = cmpVersion(left.min, right.min);
  if (order > 0) return { min: left.min, minInclusive: left.minInclusive };
  if (order < 0) return { min: right.min, minInclusive: right.minInclusive };
  return { min: left.min, minInclusive: left.minInclusive && right.minInclusive };
}

function lowerUpperBound(left, right) {
  if (!left.max) return { max: right.max, maxInclusive: right.maxInclusive };
  if (!right.max) return { max: left.max, maxInclusive: left.maxInclusive };
  const order = cmpVersion(left.max, right.max);
  if (order < 0) return { max: left.max, maxInclusive: left.maxInclusive };
  if (order > 0) return { max: right.max, maxInclusive: right.maxInclusive };
  return { max: left.max, maxInclusive: left.maxInclusive && right.maxInclusive };
}

function intersectIntervals(left, right) {
  const lower = higherLowerBound(left, right);
  const upper = lowerUpperBound(left, right);
  if (lower.min && upper.max && endsBefore(upper.max, upper.maxInclusive, lower.min, lower.minInclusive)) {
    return null;
  }
  return {
    min: lower.min,
    minInclusive: lower.minInclusive,
    max: upper.max,
    maxInclusive: upper.maxInclusive,
  };
}

function intervalsOverlap(left, right) {
  if (left.max && right.min && endsBefore(left.max, left.maxInclusive, right.min, right.minInclusive)) return false;
  if (right.max && left.min && endsBefore(right.max, right.maxInclusive, left.min, left.minInclusive)) return false;
  return true;
}

export function parseRange(range) {
  if (typeof range !== 'string') return null;
  const alternatives = range
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (alternatives.length === 0) return null;
  const intervals = [];
  for (const alternative of alternatives) {
    let interval = unbounded();
    for (const token of alternative.split(/\s+/)) {
      const next = parseComparator(token);
      if (!next) return null;
      interval = intersectIntervals(interval, next);
      if (!interval) break;
    }
    if (interval) intervals.push(interval);
  }
  return intervals;
}

export function rangesIntersect(leftRange, rightRange) {
  const left = parseRange(leftRange);
  const right = parseRange(rightRange);
  if (!left || !right) return undefined;
  for (const leftInterval of left) {
    for (const rightInterval of right) {
      if (intervalsOverlap(leftInterval, rightInterval)) return true;
    }
  }
  return false;
}

export function peerDevRangeProblems(packageJson) {
  const packageName = packageJson?.name ?? '<unknown>';
  const peers = packageJson?.peerDependencies;
  const devs = packageJson?.devDependencies;
  if (!peers || typeof peers !== 'object' || !devs || typeof devs !== 'object') return [];
  const problems = [];
  for (const [dependency, peerRange] of Object.entries(peers)) {
    if (dependency.startsWith('@tslock/')) continue;
    if (!Object.hasOwn(devs, dependency)) continue;
    const devRange = devs[dependency];
    const intersection = rangesIntersect(peerRange, devRange);
    if (intersection === undefined) {
      problems.push(
        `${packageName}: devDependencies.${dependency} (${String(devRange)}) could not be compared with peerDependencies.${dependency} (${String(peerRange)})`,
      );
      continue;
    }
    if (!intersection) {
      problems.push(
        `${packageName}: devDependencies.${dependency} (${String(devRange)}) does not intersect peerDependencies.${dependency} (${String(peerRange)})`,
      );
    }
  }
  return problems;
}

export function workspacePeerDevRangeProblems(workspaceRoot = root) {
  const problems = [];
  const manifestPaths = [join(workspaceRoot, 'package.json')];
  for (const directory of readdirSync(join(workspaceRoot, 'packages')).sort()) {
    manifestPaths.push(join(workspaceRoot, 'packages', directory, 'package.json'));
  }
  for (const manifestPath of manifestPaths) {
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    problems.push(...peerDevRangeProblems(packageJson));
  }
  return problems;
}

function main() {
  const problems = workspacePeerDevRangeProblems();
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Non-@tslock devDependency ranges intersect their peer ranges.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
