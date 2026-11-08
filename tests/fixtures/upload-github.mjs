// Fake GitHub for the upload CLI, loaded with `node --import`. No network request may leave this process.
// It answers every query shape upload.mjs uses (and the older shapes, for replay comparisons) from a world snapshot:
//   UPLOAD_FIXTURE_WORLD  path to the world JSON (format below)
//   UPLOAD_FIXTURE_LOG    optional path; one line per request: "<METHOD> <path>" or "POST graphql <shape> [repo] [batch size]"
// World: {
//   now,                       server time (Date header) and the `now` passed to computeBoard
//   members: [login],
//   repos: [{ id, name, isArchived, isFork, createdAt, head,
//             items: [GraphQL PullRequest/Issue node with __typename, number, createdAt, updatedAt, ...;
//                     hidden: true keeps it reachable by number but out of totalCount and connections, as GitHub does for some PRs],
//             commits: [REST commit objects listed from head since createdAt, in GitHub order],
//             extraCommits: [REST commit objects not listed, e.g. a force-pushed-away head],
//             totals: { pr, issue }   optional totalCount as recorded, when GitHub counts fewer items than it serves }],
//   nodes: { [node id]: { closer?: actor|null, files?: { nodes }, assoc?: number, lines?: { additions, deletions } } },
//   pages: { commit, tree, blobs: { path: sha } } | absent, publish: boolean,
//   fail: [{ match: substring of URL or query, status, retryAfter?, body }]   each entry fails one matching request
//   issuePageSize: number      page size of the fallback issues connection (default 100)
//   compareTruncate: number    compare returns at most this many commits in total
// }
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const worldFile = process.env.UPLOAD_FIXTURE_WORLD;
const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
const logFile = process.env.UPLOAD_FIXTURE_LOG;
const now = new Date(world.now);

// computeBoard gets the world's time, so runs at different wall-clock times are comparable
const runInNewContext = vm.runInNewContext;
vm.runInNewContext = function (...args) {
  const out = runInNewContext.apply(this, args);
  if (typeof out?.computeBoard === 'function') {
    const computeBoard = out.computeBoard;
    out.computeBoard = (data, rules) => computeBoard(data, rules, now.getTime());
  }
  return out;
};

const record = (line) => { if (logFile) fs.appendFileSync(logFile, `${line}\n`); };
const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { date: now.toUTCString(), 'content-type': 'application/json', ...headers },
});
const byUpdated = (list) => [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
const newest = (list) => [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number)[0];
const page = (list, first, cursor) => {
  const start = cursor ? Number(cursor) : 0;
  const nodes = list.slice(start, start + first);
  return { pageInfo: { hasNextPage: start + first < list.length, endCursor: String(start + nodes.length) }, nodes };
};
const repoByName = (name) => world.repos.find((r) => r.name === name);
const kind = (it) => (it.hidden ? 'hidden' : it.__typename);
const strip = ({ hidden, ...it }) => it;

// User accounts by node id, as the world shows them now (GraphQL actors and REST commit authors)
let users;
function userById(id) {
  if (!users) {
    users = new Map();
    const note = (a) => { if (a?.__typename === 'User' && a.id) users.set(a.id, a.login); };
    for (const r of world.repos) {
      for (const it of r.items) {
        note(it.author);
        note(it.mergedBy);
        for (const x of [...(it.reviews?.nodes || []), ...it.comments.nodes]) note(x.author);
      }
      for (const c of r.commits) if (c.author?.type === 'User' && c.author.node_id) users.set(c.author.node_id, c.author.login);
    }
    for (const n of Object.values(world.nodes || {})) note(n.closer);
  }
  return users.get(id);
}

function failure(target) {
  const i = (world.fail || []).findIndex((f) => target.includes(f.match));
  if (i < 0) return null;
  const [f] = world.fail.splice(i, 1);
  return new Response(f.body || '', { status: f.status, headers: { date: now.toUTCString(), ...(f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {}) } });
}

function graphql(query, variables) {
  const errors = [];
  let data;
  if (query.includes('organization(login:')) {
    const firstOf = (alias) => Number(new RegExp(`${alias}: \\w+\\(first: (\\d+)`).exec(query)?.[1] || 0);
    const org = {};
    if (variables.needMembers) org.membersWithRole = page(world.members.map((login) => ({ login })), 100, variables.memberCursor);
    if (variables.needRepos !== false) {
      const repos = page(world.repos, 100, variables.repoCursor);
      repos.nodes = repos.nodes.map((r) => {
        const prs = r.items.filter((it) => kind(it) === 'PullRequest');
        const issues = r.items.filter((it) => kind(it) === 'Issue');
        const recent = (list, first) => {
          const p = page(byUpdated(list), first);
          return { ...p, nodes: p.nodes.map(({ number, updatedAt }) => ({ number, updatedAt })) };
        };
        return {
          id: r.id, name: r.name, isArchived: !!r.isArchived, isFork: !!r.isFork, createdAt: r.createdAt,
          pullRequests: { totalCount: r.totals?.pr ?? prs.length, nodes: prs.length ? [{ number: newest(prs).number }] : [] },
          issues: { totalCount: r.totals?.issue ?? issues.length, nodes: issues.length ? [{ number: newest(issues).number }] : [] },
          updatedPrs: recent(prs, firstOf('updatedPrs')),
          updatedIssues: recent(issues, firstOf('updatedIssues')),
          defaultBranchRef: r.head ? { target: { oid: r.head, history: { totalCount: r.commits.length } } } : null,
        };
      });
      org.repositories = repos;
    }
    data = { organization: org };
  } else if (query.includes('issueOrPullRequest')) {
    const repo = repoByName(variables.repo);
    const out = {};
    for (const [, alias, n] of query.matchAll(/(n\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
      const it = repo.items.find((x) => x.number === Number(n));
      out[alias] = it ? strip(it) : null;
      if (!it) errors.push({ type: 'NOT_FOUND', path: ['repository', alias], message: `Could not resolve to an issue or pull request with the number of ${n}.` });
    }
    data = { repository: out };
  } else if (query.includes('updatedPrs')) {
    const repo = repoByName(variables.repo);
    const list = (type, cursor) => {
      const p = page(byUpdated(repo.items.filter((it) => kind(it) === type)), 100, cursor);
      return { ...p, nodes: p.nodes.map(({ number, updatedAt }) => ({ number, updatedAt })) };
    };
    data = { repository: {
      ...(variables.needPrs ? { updatedPrs: list('PullRequest', variables.prCursor) } : {}),
      ...(variables.needIssues ? { updatedIssues: list('Issue', variables.issueCursor) } : {}),
    } };
  } else if (query.includes('issues(first: 100, after')) {
    const repo = repoByName(variables.repo);
    const issues = repo.items.filter((it) => kind(it) === 'Issue').sort((a, b) => a.number - b.number);
    data = { repository: { issues: page(issues, world.issuePageSize || 100, variables.cursor) } };
  } else if (query.includes('nodes(ids:')) {
    const pick = (id) => {
      if (query.includes('... on User')) return userById(id) ? { id, login: userById(id) } : null;
      const n = world.nodes?.[id];
      if (query.includes('timelineItems')) return n && 'closer' in n ? { id, timelineItems: { nodes: n.closer ? [{ actor: n.closer }] : [] } } : null;
      if (query.includes('files(first')) return n?.files ? { id, files: n.files } : null;
      if (query.includes('associatedPullRequests')) return n && 'assoc' in n ? { id, associatedPullRequests: { totalCount: n.assoc } } : null;
      if (query.includes('additions deletions')) return n?.lines ? { id, ...n.lines } : null;
      throw new Error('Unexpected fixture nodes query');
    };
    data = { nodes: variables.ids.map(pick) };
  } else {
    throw new Error(`Unexpected fixture query: ${query.slice(0, 80)}`);
  }
  if (query.includes('rateLimit')) data.rateLimit = { cost: query.includes('organization(login:') ? 4 : 1 };
  return { data, ...(errors.length ? { errors } : {}) };
}

function reachable(repo, from) {
  const all = new Map([...repo.commits, ...(repo.extraCommits || [])].map((c) => [c.sha, c]));
  const out = new Set();
  const stack = [from];
  while (stack.length) {
    const sha = stack.pop();
    if (out.has(sha) || !all.has(sha)) continue;
    out.add(sha);
    for (const p of all.get(sha).parents) stack.push(p.sha);
  }
  return { all, out };
}

const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const savePages = () => fs.writeFileSync(worldFile, JSON.stringify(world));

function rest(method, url, body) {
  const pagesBase = `/repos/${process.env.PAGES_REPO || 'nwverse/contribution'}/git`;
  let m;
  if (method === 'GET' && (m = /^\/repos\/[^/]+\/([^/]+)\/commits$/.exec(url.pathname))) {
    const repo = repoByName(m[1]);
    const q = url.searchParams;
    if (q.get('sha') !== repo.head || q.get('since') !== repo.createdAt) throw new Error('Fixture lists only the head since creation');
    const per = Number(q.get('per_page'));
    const n = Number(q.get('page') || 1);
    const last = Math.max(1, Math.ceil(repo.commits.length / per));
    const link = n < last ? { link: `<https://api.github.com${url.pathname}?sha=${repo.head}&per_page=${per}&page=${n + 1}>; rel="next", <https://api.github.com${url.pathname}?sha=${repo.head}&per_page=${per}&page=${last}>; rel="last"` } : {};
    return reply(200, repo.commits.slice((n - 1) * per, n * per), link);
  }
  if (method === 'GET' && (m = /^\/repos\/[^/]+\/([^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url.pathname))) {
    const repo = repoByName(m[1]);
    const head = reachable(repo, m[3]);
    if (!head.all.has(m[2])) return reply(404, { message: 'Not Found' });
    const base = reachable(repo, m[2]).out;
    const ahead = [...head.out].filter((s) => !base.has(s)).map((s) => head.all.get(s)).sort((a, b) => Date.parse(a.commit.committer.date) - Date.parse(b.commit.committer.date));
    const behind = [...base].filter((s) => !head.out.has(s)).length;
    const status = ahead.length && behind ? 'diverged' : behind ? 'behind' : ahead.length ? 'ahead' : 'identical';
    const per = Number(url.searchParams.get('per_page') || 250);
    const n = Number(url.searchParams.get('page') || 1);
    // compareTruncate: GitHub stops returning commits after this many while total_commits stays complete
    const shown = ahead.slice(0, world.compareTruncate ?? ahead.length);
    return reply(200, { status, ahead_by: ahead.length, behind_by: behind, total_commits: ahead.length, commits: shown.slice((n - 1) * per, n * per), files: [] });
  }
  if (!world.pages) throw new Error('Fixture refuses publication requests');
  const p = world.pages;
  if (method === 'GET' && url.pathname === `${pagesBase}/ref/heads/gh-pages`) {
    return reply(200, { object: { sha: p.commit } });
  }
  if (method === 'GET' && url.pathname === `${pagesBase}/commits/${p.commit}`) return reply(200, { sha: p.commit, tree: { sha: p.tree } });
  if (method === 'GET' && url.pathname === `${pagesBase}/trees/${p.tree}`) {
    return reply(200, { sha: p.tree, tree: Object.entries(p.blobs).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })) });
  }
  if (!world.publish) throw new Error('Fixture refuses publication requests');
  if (method === 'POST' && url.pathname === `${pagesBase}/blobs`) return reply(201, { sha: blobSha(Buffer.from(body.content, 'base64')) });
  if (method === 'POST' && url.pathname === `${pagesBase}/trees`) {
    p.pending = { ...p.blobs, ...Object.fromEntries(body.tree.map((e) => [e.path, e.sha])) };
    return reply(201, { sha: createHash('sha1').update(JSON.stringify(p.pending)).digest('hex') });
  }
  if (method === 'POST' && url.pathname === `${pagesBase}/commits`) {
    p.next = { tree: body.tree, commit: createHash('sha1').update(body.tree + body.parents.join()).digest('hex') };
    return reply(201, { sha: p.next.commit });
  }
  if (method === 'PATCH' && url.pathname === `${pagesBase}/refs/heads/gh-pages`) {
    Object.assign(p, { commit: p.next.commit, tree: p.next.tree, blobs: p.pending });
    delete p.next;
    delete p.pending;
    savePages();
    return reply(200, { object: { sha: p.commit } });
  }
  throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') throw new Error('Fixture refuses network requests');
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  const isGraphql = url.pathname === '/graphql';
  if (isGraphql) {
    const shape = /organization\(login:|issueOrPullRequest|updatedPrs|issues\(first: 100, after|timelineItems|files\(first|associatedPullRequests|additions deletions|on User/.exec(body.query)?.[0];
    const size = body.variables?.ids?.length ?? (body.query.match(/issueOrPullRequest\(/g) || []).length;
    record(`${method} graphql ${shape}${body.variables?.repo ? ` ${body.variables.repo}` : ''}${size ? ` ${size}` : ''}`);
  } else {
    record(`${method} ${url.pathname.replace(/\/[0-9a-f]{40}(\.\.\.[0-9a-f]{40})?/g, '/<sha>')}`);
  }
  const failed = failure(isGraphql ? body.query : url.href);
  if (failed) return failed;
  return isGraphql ? reply(200, graphql(body.query, body.variables || {})) : rest(method, url, body);
};
