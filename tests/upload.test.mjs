import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/upload-github.mjs', import.meta.url));
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const clone = (x) => structuredClone(x);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'contribution-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The real CLI runs against the fake GitHub with a synthetic token. The script is copied so that dist/ lands in
// the sandbox; site files are symlinked because a dry-run compares them with the publishing branch.
function sandbox(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/upload.mjs'), path.join(dir, 'scripts/upload.mjs'));
  for (const entry of fs.readdirSync(root)) {
    if (!['scripts', 'dist', 'node_modules', '.git', 'tests'].includes(entry)) fs.symlinkSync(path.join(root, entry), path.join(dir, entry));
  }
  return dir;
}

function run(dir, world, { args = ['--dry-run'], cache = 'cache' } = {}) {
  const worldFile = path.join(dir, 'world.json');
  const logFile = path.join(dir, 'requests.log');
  fs.writeFileSync(worldFile, JSON.stringify(world));
  fs.rmSync(logFile, { force: true });
  const stdout = execFileSync(process.execPath, ['--import', fixture, path.join(dir, 'scripts/upload.mjs'), ...args, ...(process.env.DEBUG_UPLOAD ? ['--verbose'] : [])], {
    cwd: dir, timeout: 20_000, encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 'fixture-only', ORG: 'fixture-org', CACHE_DIR: path.join(dir, cache), UPLOAD_FIXTURE_WORLD: worldFile, UPLOAD_FIXTURE_LOG: logFile },
  });
  return {
    stdout,
    board: args.includes('--dry-run') ? JSON.parse(fs.readFileSync(path.join(dir, 'dist/board.json'), 'utf8')) : null,
    requests: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [],
    world: JSON.parse(fs.readFileSync(worldFile, 'utf8')),
    cacheFile: path.join(dir, cache, 'fixture-org.json'),
  };
}
const cold = (dir, world) => run(dir, world, { args: ['--dry-run', '--no-cache'], cache: `cold-${Math.random()}` });
const count = (requests, pattern) => requests.filter((r) => r.includes(pattern)).length;

// ---------- world builders ----------

// Node ids survive a rename: david is dave after renaming the account
const ID_OF = { david: 'dave' };
const user = (login) => ({ login, __typename: 'User', id: `U_${ID_OF[login] ?? login}` });
const thread = (list) => ({ totalCount: list.length, nodes: list });
function pr(repo, number, login, o = {}) {
  const closedAt = o.closedAt ?? o.mergedAt ?? null;
  return {
    __typename: 'PullRequest', id: `PR_${repo}_${number}`, number,
    state: o.mergedAt ? 'MERGED' : closedAt ? 'CLOSED' : 'OPEN',
    createdAt: o.createdAt, updatedAt: o.updatedAt ?? closedAt ?? o.createdAt, mergedAt: o.mergedAt ?? null, closedAt,
    additions: o.additions ?? 40, deletions: o.deletions ?? 4, author: user(login), mergedBy: o.mergedAt ? user(o.mergedBy ?? login) : null,
    reviews: thread((o.reviews ?? []).map(([who, at]) => ({ author: user(who), submittedAt: at }))),
    comments: thread((o.comments ?? []).map(([who, at]) => ({ author: user(who), createdAt: at }))),
    commits: { totalCount: 1, nodes: [{ commit: { author: { name: o.commitAuthor ?? login }, message: o.message ?? 'Change' } }] },
  };
}
function issue(number, login, o = {}) {
  return {
    __typename: 'Issue', number, state: o.closedAt ? 'CLOSED' : 'OPEN', stateReason: o.closedAt ? 'COMPLETED' : null,
    createdAt: o.createdAt, updatedAt: o.updatedAt ?? o.closedAt ?? o.createdAt, closedAt: o.closedAt ?? null,
    author: user(login), comments: thread((o.comments ?? []).map(([who, at]) => ({ author: user(who), createdAt: at }))),
  };
}
const pages = () => ({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), blobs: {} });
const repo = (id, name, createdAt, o = {}) => ({ id, name, isArchived: false, isFork: false, createdAt, head: null, items: [], commits: [], ...o });

// A real git repository is the oracle for commit order: `git log --since` walks exactly like the GitHub commit list.
const LOGINS = { alice: 'alice', bob: 'bob', carol: 'carol', dave: 'dave' };
function gitRepo(t) {
  const dir = tempDir(t);
  const g = (args, env = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', ...env } }).trim();
  g(['init', '-q']);
  const tree = g(['hash-object', '-t', 'tree', '/dev/null']);
  const made = [];
  const commit = (name, at, message, ...parents) => {
    const date = `@${Date.parse(at) / 1000} +0000`;
    const sha = g(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.com`, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.com`, GIT_COMMITTER_DATE: date,
    });
    made.push(sha);
    return sha;
  };
  const parse = (out) => out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [sha, parents, name, at, ct, message] = rec.split('\x1f');
    return {
      sha, node_id: `C_${sha.slice(0, 12)}`, parents: parents.split(' ').filter(Boolean).map((p) => ({ sha: p })),
      author: LOGINS[name] ? { login: LOGINS[name], type: 'User', node_id: `U_${name}` } : null,
      commit: { author: { name, date: iso(Number(at) * 1000) }, committer: { date: iso(Number(ct) * 1000) }, message: message.replace(/\n$/, '') },
    };
  });
  const FORMAT = '--format=%H%x1f%P%x1f%an%x1f%at%x1f%ct%x1f%B%x1e';
  // { head, commits: listed in GitHub order, extraCommits: every other commit made so far }
  const snapshot = (head, since) => {
    const commits = parse(g(['log', FORMAT, `--since=@${Date.parse(since) / 1000}`, head]));
    const listed = new Set(commits.map((c) => c.sha));
    return { head, commits, extraCommits: parse(g(['log', '--no-walk', FORMAT, ...made.filter((s) => !listed.has(s))])) };
  };
  return { commit, snapshot };
}

// ---------- scenarios carried over from the batched issue scan ----------

function issueWorld(scenario) {
  const items = [issue(1, 'fixture-recent', { createdAt: '2026-11-01T00:00:00Z' })];
  // Creation order leads with #1; the older transferred issue received #150 on arrival.
  if (scenario === 'gap') items.push(issue(150, 'fixture-transferred', { createdAt: '2026-01-01T00:00:00Z' }));
  return { now: '2026-11-02T00:00:00Z', members: [], issuePageSize: 1, pages: pages(), repos: [repo('R_p', 'fixture-project', '2025-01-01T00:00:00Z', { items })] };
}

test('upload includes older transferred issues beyond an empty number batch exactly once', (t) => {
  const { board, requests } = run(sandbox(t), issueWorld('gap'));
  assert.equal(board.summary.issues, 2);
  assert.deepEqual(board.people.map((person) => person.login).sort(), ['fixture-recent', 'fixture-transferred']);
  assert.ok(board.people.every((person) => person.issuesFiled === 1 && person.collab === 1));
  // Two pages of one issue each: the fallback follows the cursor and skips #1, already read by number
  assert.equal(count(requests, 'issues(first: 100, after'), 2);
});

test('upload keeps the batched scan when every issue was already found', (t) => {
  const { board, requests } = run(sandbox(t), issueWorld('complete'));
  assert.equal(board.summary.issues, 1);
  assert.deepEqual(board.people.map((person) => person.login), ['fixture-recent']);
  assert.equal(count(requests, 'issues(first: 100, after'), 0);
});

// ---------- incremental sync ----------

// W0 and W1 share repositories: `app` gains commits (fast-forward), `svc` gains and changes PRs and issues,
// `docs` loses an issue, `old-name` is renamed and `gone` is deleted.
function worlds(t) {
  const git = gitRepo(t);
  const created = '2026-10-01T00:00:00Z';
  const c0 = git.commit('alice', '2026-09-01T00:00:00Z', 'Imported history');
  const c1 = git.commit('alice', '2026-10-02T00:00:00Z', 'Direct one', c0);
  const f1 = git.commit('bob', '2026-10-03T00:00:00Z', 'Feature part 1', c1);
  const f2 = git.commit('bob', '2026-10-03T00:00:00Z', 'Feature part 2', f1);
  const c2 = git.commit('alice', '2026-10-04T00:00:00Z', 'Direct two', c1);
  const m1 = git.commit('alice', '2026-10-05T00:00:00Z', 'Merge feature', c2, f2);
  const d1 = git.commit('dave', '2026-10-05T12:00:00Z', 'Direct by dave', m1);
  const c3 = git.commit('bob', '2026-10-06T00:00:00Z', 'Direct three\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', d1);
  const app0 = git.snapshot(c3, created);
  // Rebased and pushed together: three commits share one committer second
  const r1 = git.commit('alice', '2026-11-02T10:00:00Z', 'Rebased 1', c3);
  const r2 = git.commit('alice', '2026-11-02T10:00:00Z', 'Rebased 2\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', r1);
  const r3 = git.commit('alice', '2026-11-02T10:00:00Z', 'Rebased 3', r2);
  // An old branch merged late interleaves by date with commits already listed. It starts from imported history,
  // which compare returns but the list leaves out. Its tip shares r3's second,
  // so both parents of the merge wait in the walk queue together and only first-in-first-out keeps GitHub's order
  const l0 = git.commit('carol', '2026-09-15T00:00:00Z', 'Imported branch', c0);
  const l1 = git.commit('carol', '2026-10-02T12:00:00Z', 'Legacy work', l0);
  const l2 = git.commit('alice', '2026-11-02T10:00:00Z', 'Legacy tip\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', l1);
  const m2 = git.commit('alice', '2026-11-02T11:00:00Z', 'Merge legacy', r3, l2);
  const s1 = git.commit('dave', '2026-11-02T12:00:00Z', 'Squashed PR (#7)', m2);
  const app1 = git.snapshot(s1, created);
  // Force-push: main is reset to c3 and rewritten
  const x1 = git.commit('bob', '2026-11-02T12:00:00Z', 'Rewritten', c3);
  const app2 = git.snapshot(x1, created);

  const direct = (c, o = {}) => [c.node_id, { assoc: 0, lines: { additions: 30, deletions: 3 }, ...o }];
  const nodesFor = (snap) => Object.fromEntries(snap.commits.filter((c) => c.parents.length <= 1).map((c) => (
    /Feature part/.test(c.commit.message) ? [c.node_id, { assoc: 1 }] : direct(c)
  )));
  const svc0 = [
    pr('svc', 1, 'alice', { createdAt: '2026-10-10T00:00:00Z', mergedAt: '2026-10-10T02:00:00Z', mergedBy: 'bob', reviews: [['bob', '2026-10-10T01:00:00Z']] }),
    pr('svc', 2, 'bob', { createdAt: '2026-10-11T00:00:00Z', closedAt: '2026-10-12T00:00:00Z' }),
    pr('svc', 3, 'carol', { createdAt: '2026-10-20T00:00:00Z', comments: [['alice', '2026-10-21T00:00:00Z']] }),
    issue(4, 'dave', { createdAt: '2026-10-13T00:00:00Z', closedAt: '2026-10-14T00:00:00Z' }),
    pr('svc', 5, 'dave', { createdAt: '2026-10-21T00:00:00Z', mergedAt: '2026-10-21T01:00:00Z', message: 'Styles', commitAuthor: 'Claude Haiku 5.5' }),
  ];
  const w0 = {
    now: '2026-11-02T00:00:00Z',
    members: ['alice', 'bob', 'carol', 'dave'],
    pages: pages(),
    repos: [
      repo('R_app', 'app', created, app0),
      repo('R_docs', 'docs', created, { items: [issue(1, 'carol', { createdAt: '2026-10-05T00:00:00Z' }), issue(2, 'bob', { createdAt: '2026-10-06T00:00:00Z' })] }),
      repo('R_gone', 'gone', created, { items: [pr('gone', 1, 'erin', { createdAt: '2026-10-07T00:00:00Z', mergedAt: '2026-10-07T01:00:00Z' })] }),
      repo('R_old', 'old-name', created, { items: [issue(1, 'erin', { createdAt: '2026-10-08T00:00:00Z' })] }),
      repo('R_svc', 'svc', created, { items: svc0 }),
    ],
    nodes: {
      ...nodesFor(app0),
      PR_svc_1: { files: { nodes: [{ path: 'src/a.js', additions: 30, deletions: 2, changeType: 'MODIFIED' }] } },
      PR_svc_2: { closer: user('alice') },
      PR_svc_5: { files: { nodes: [{ path: 'src/app.css', additions: 40, deletions: 4, changeType: 'MODIFIED' }] } },
      PR_gone_1: { files: { nodes: [] } },
    },
  };

  const w1 = clone(w0);
  w1.now = '2026-11-03T00:00:00Z';
  Object.assign(w1.repos[0], app1);
  Object.assign(w1.nodes, nodesFor(app1));
  // s1 is the squash commit of app#7, committed within 2 seconds of its author's merge: generated by the merge, not a direct push
  w1.repos[0].items.push(pr('app', 7, 'dave', { createdAt: '2026-11-02T08:00:00Z', mergedAt: '2026-11-02T12:00:01Z' }));
  w1.nodes.PR_app_7 = { files: { nodes: [] } };
  w1.repos[1].items.splice(1, 1);
  w1.repos.splice(2, 1);
  w1.repos[2].name = 'new-name';
  const svc = w1.repos[3].items;
  svc[1] = pr('svc', 2, 'bob', { createdAt: '2026-10-11T00:00:00Z', closedAt: '2026-11-02T06:00:00Z' });
  svc[2] = pr('svc', 3, 'carol', { createdAt: '2026-10-20T00:00:00Z', mergedAt: '2026-11-02T09:30:00Z', mergedBy: 'alice', comments: [['alice', '2026-10-21T00:00:00Z']] });
  svc[3] = issue(4, 'dave', { createdAt: '2026-10-13T00:00:00Z', closedAt: '2026-10-14T00:00:00Z', updatedAt: '2026-11-02T05:00:00Z', comments: [['alice', '2026-11-02T05:00:00Z']] });
  Object.assign(w1.nodes, {
    PR_svc_2: { closer: user('bob') },
    PR_svc_3: { files: { nodes: [{ path: 'src/b.js', additions: 40, deletions: 4, changeType: 'ADDED' }] } },
  });

  const w2 = clone(w1);
  w2.now = '2026-11-03T01:00:00Z';
  Object.assign(w2.repos[0], app2);
  Object.assign(w2.nodes, nodesFor(app2));
  return { w0, w1, w2 };
}

test('a warm run after changes produces the same board and commit order as a full fetch', (t) => {
  const dir = sandbox(t);
  const { w0, w1 } = worlds(t);
  const first = run(dir, w0);
  assert.match(first.stdout, /全量拉取（没有缓存）/);
  const warm = run(dir, w1);
  const full = cold(dir, w1);
  assert.deepEqual(warm.board, full.board);

  const warmCache = JSON.parse(fs.readFileSync(warm.cacheFile, 'utf8'));
  const fullCache = JSON.parse(fs.readFileSync(full.cacheFile, 'utf8'));
  assert.deepEqual(warmCache.repos, fullCache.repos);
  assert.deepEqual(Object.keys(warmCache.repos).sort(), ['R_app', 'R_docs', 'R_old', 'R_svc']);
  assert.equal(warmCache.repos.R_old.name, 'new-name');
  // Commits of one person in one second are credited in list order, so the model weights depend on it
  assert.ok(full.board.people.find((p) => p.login === 'alice').bonusModel > 0);

  // Only changes are fetched again: svc #2 #3 #4 and app #7 by number, docs in full after losing an issue
  assert.deepEqual(warm.requests.filter((r) => r.includes('issueOrPullRequest')).sort(), [
    'POST graphql issueOrPullRequest app 1', 'POST graphql issueOrPullRequest docs 1', 'POST graphql issueOrPullRequest svc 3',
  ]);
  assert.match(warm.stdout, /整仓重拉 1 次/);
  // app moved forward: one compare; the only listed page is the verification slice (slot 0 checks page 1)
  assert.equal(count(warm.requests, '/compare/'), 1);
  assert.equal(count(warm.requests, '/commits'), 1);
});

// Rename dave to david everywhere without touching updatedAt or heads, as GitHub does
function renamed(world) {
  const out = clone(world);
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if ((x.id === 'U_dave' || x.node_id === 'U_dave') && x.login === 'dave') x.login = 'david';
      Object.values(x).forEach(walk);
    }
  };
  walk(out);
  return out;
}

test('an account rename, which changes no updatedAt, refreshes the items, closers and commits that mention it', (t) => {
  const dir = sandbox(t);
  const { w1 } = worlds(t);
  run(dir, w1);
  const w = renamed(w1);
  const warm = run(dir, w);
  const full = cold(dir, w);
  assert.deepEqual(warm.board, full.board);
  assert.ok(full.board.people.some((p) => p.login === 'david') && !full.board.people.some((p) => p.login === 'dave'));
  // dave appears in svc #4, #5 and app #7, and authored commits in app: those are fetched again, nothing else
  assert.deepEqual(warm.requests.filter((r) => r.includes('issueOrPullRequest')).sort(), [
    'POST graphql issueOrPullRequest app 1', 'POST graphql issueOrPullRequest svc 2',
  ]);
  assert.equal(count(warm.requests, '/compare/'), 0);
});

test('a PR reachable by number but missing from totalCount does not force a rescan every run', (t) => {
  const dir = sandbox(t);
  const world = issueWorld('complete');
  world.repos[0].items.push({ ...pr('fixture-project', 2, 'fixture-hidden', { createdAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-02T00:00:00Z' }), hidden: true });
  world.repos[0].items.push(pr('fixture-project', 3, 'fixture-hidden', { createdAt: '2026-10-03T00:00:00Z' }));
  world.nodes = { PR_fixture_project_2: { closer: user('fixture-hidden') } };
  const first = run(dir, world);
  assert.equal(first.board.summary.prs, 2);
  const again = run(dir, world);
  assert.deepEqual(again.board, first.board);
  assert.match(again.stdout, /整仓重拉 0 次/);
  assert.equal(count(again.requests, 'issueOrPullRequest'), 0);
});

test('a force-pushed branch or an incomplete comparison is listed again in full', (t) => {
  const dir = sandbox(t);
  const { w0, w1, w2 } = worlds(t);
  const base = run(dir, w0);
  // Slot 5 leaves app's single commit page out of the verification slice, so only the compare guard can notice
  fs.writeFileSync(base.cacheFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(base.cacheFile, 'utf8')), slot: 5 }));
  const truncated = { ...clone(w1), compareTruncate: 2 };
  const partial = run(dir, truncated);
  assert.deepEqual(partial.board, cold(dir, truncated).board);
  assert.match(partial.stdout, /整仓重拉 2 次/);

  run(dir, w1);
  const warm = run(dir, w2);
  assert.deepEqual(warm.board, cold(dir, w2).board);
  assert.equal(count(warm.requests, '/compare/'), 1);
  assert.ok(count(warm.requests, '/commits') > 0);

  // The old head no longer exists at all: compare answers 404
  const gone = clone(w2);
  gone.repos[0].extraCommits = [];
  const cache = JSON.parse(fs.readFileSync(warm.cacheFile, 'utf8'));
  cache.repos.R_app.head = 'f'.repeat(40);
  fs.writeFileSync(warm.cacheFile, JSON.stringify(cache));
  assert.deepEqual(run(dir, gone).board, cold(dir, gone).board);
});

// slotOf in upload.mjs: the verification slice that will re-fetch this id
const slotOf = (key) => [...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % 24;

test('rolling verification replaces a wrong cache entry; --no-cache and a corrupt cache fetch everything', (t) => {
  const dir = sandbox(t);
  const { w0 } = worlds(t);
  const truth = run(dir, w0);
  const cache = JSON.parse(fs.readFileSync(truth.cacheFile, 'utf8'));
  // Pretend the cached file list of svc#1 went wrong: it now looks like a stylesheet-only PR
  cache.files.PR_svc_1 = { nodes: [{ path: 'src/a.css', additions: 30, deletions: 30, changeType: 'MODIFIED' }] };
  const poisoned = (slot) => fs.writeFileSync(truth.cacheFile, JSON.stringify({ ...cache, slot }));

  poisoned((slotOf('PR_svc_1') + 1) % 24);
  assert.notDeepEqual(run(dir, w0).board, truth.board, 'the cache is used when its slice is not verified');

  poisoned(slotOf('PR_svc_1'));
  const verified = run(dir, w0);
  assert.deepEqual(verified.board, truth.board);
  assert.match(verified.stdout, /校验：1 项与缓存不符/);

  poisoned((slotOf('PR_svc_1') + 1) % 24);
  const fresh = run(dir, w0, { args: ['--dry-run', '--no-cache'] });
  assert.deepEqual(fresh.board, truth.board);
  assert.match(fresh.stdout, /全量拉取（--no-cache）/);

  fs.writeFileSync(truth.cacheFile, '{"version":');
  const repaired = run(dir, w0);
  assert.deepEqual(repaired.board, truth.board);
  assert.match(repaired.stdout, /全量拉取（缓存已损坏/);
});

test('a secondary rate limit pauses requests for Retry-After and retries', (t) => {
  const world = issueWorld('complete');
  world.fail = [{ match: 'issueOrPullRequest', status: 403, retryAfter: 1, body: '{"message":"You have exceeded a secondary rate limit."}' }];
  const { board, stdout } = run(sandbox(t), world);
  assert.equal(board.summary.issues, 1);
  assert.match(stdout, /二级限流（HTTP 403），全部请求暂停 1 秒/);
  assert.match(stdout, /重试 1 次/);
});

test('publishing uploads only changed files and skips an unchanged branch', (t) => {
  const dir = sandbox(t);
  const source = fs.readFileSync(path.join(root, 'scripts/upload.mjs'), 'utf8');
  const siteFiles = [.../const SITE_FILES = \[([\s\S]*?)\];/.exec(source)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const blob = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
  const world = { ...issueWorld('complete'), publish: true };
  world.pages.blobs = Object.fromEntries(siteFiles.map((f) => [f, blob(fs.readFileSync(path.join(root, f)))]));

  const first = run(dir, world, { args: [] });
  assert.match(first.stdout, /已发布到 nwverse\/contribution@gh-pages/);
  assert.equal(count(first.requests, 'POST /repos/nwverse/contribution/git/blobs'), 1);
  assert.ok(first.world.pages.blobs['data/board.json']);

  const second = run(dir, first.world, { args: [] });
  assert.match(second.stdout, /内容没有变化，未提交/);
  // The branch still points at the commit published last time: its file list comes from the cache
  assert.deepEqual(second.requests.filter((r) => r.includes('/git/')), ['GET /repos/nwverse/contribution/git/ref/heads/gh-pages']);
});
