#!/usr/bin/env node
// 拉取 GitHub 组织数据，计算人维度的贡献度，把页面、资源、引擎与 data/board.json 一次提交到发布分支。
// 用法：node scripts/upload.mjs [--dry-run] [--no-cache] [--verbose]
//   --dry-run   只拉取和计算，结果写到 dist/board.json，不发布；仍读取发布分支，报告内容有没有变化
//   --no-cache  不读缓存，全量拉取后重建缓存
//   --verbose   输出各仓库的同步方式、重试与各阶段的耗时和请求数
// 环境变量见 README.md。依赖 Node.js 18 及以上，无第三方依赖。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = process.env.ORG || 'nwverse';
const PAGES_REPO = process.env.PAGES_REPO || 'nwverse/contribution';
const PAGES_BRANCH = process.env.PAGES_BRANCH || 'gh-pages';
const DRY_RUN = process.argv.includes('--dry-run');
const NO_CACHE = process.argv.includes('--no-cache');
const VERBOSE = process.argv.includes('--verbose');
// 随数据一起发布的站点文件，保证页面与生成数据的引擎是同一版本
const SITE_FILES = [
  'index.html', 'ranking.html', 'profile.html', 'hatchery.html', 'pond.html', 'rules.html',
  'engine.js',
  'assets/boot.js', 'assets/derive.js', 'assets/icons.js', 'assets/kit.js', 'assets/tokens.css',
  '.nojekyll', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png',
  'docs/assets/promo-preview.webp',
];

const engineSource = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const { RULES, computeBoard } = vm.runInNewContext(`${engineSource}\n;({ RULES, computeBoard })`);

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const debug = (msg) => { if (VERBOSE) log(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 阶段统计 ----------

// 各阶段的墙钟耗时与请求数。阶段之间并发执行，耗时互相重叠，不能相加。
const PHASES = {
  cache: '缓存读写', meta: '成员与仓库', actors: '账号核对', items: 'PR/issue', closers: '关闭人', files: '改动文件',
  commits: 'commit 列表', 'commit-pr': 'commit 归属', 'commit-lines': 'commit 改动行', compute: '计算', publish: '发布',
};
const phases = new Map();
function stat(name) {
  if (!phases.has(name)) phases.set(name, { ms: 0, graphql: 0, points: 0, rest: 0, retries: 0 });
  return phases.get(name);
}
async function timed(name, fn) {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    stat(name).ms += performance.now() - t;
  }
}
function totals() {
  const t = { graphql: 0, points: 0, rest: 0, retries: 0 };
  for (const s of phases.values()) for (const k of Object.keys(t)) t[k] += s[k];
  return t;
}
function phaseTable() {
  const rows = [...phases].map(([k, s]) => `  ${(PHASES[k] || k).padEnd(12)} ${(s.ms / 1000).toFixed(1).padStart(6)} 秒  GraphQL ${String(s.graphql).padStart(4)} 次 ${String(s.points).padStart(4)} 点  REST ${String(s.rest).padStart(4)} 次  重试 ${s.retries}`);
  return ['各阶段（并发执行，耗时有重叠）：', ...rows].join('\n');
}

// ---------- 请求 ----------

const GRAPHQL = 'https://api.github.com/graphql';
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 90_000;
// 额度用尽时最多等这么久，再长就失败退出，留给下一轮
const MAX_RESET_WAIT_S = 120;

// GraphQL 与 REST 各自限制同时进行的请求数。二级限流（secondary rate limit）按并发和服务端耗时计算：
// GraphQL 重查询并发 16 时已会触发，所以 GraphQL 起步 12，每次遇到二级限流减半，最低 4；REST 列 commit 并发 16 未触发。
function semaphore(limit) {
  let active = 0;
  const waiting = [];
  const s = {
    limit,
    async acquire() {
      while (active >= s.limit) await new Promise((r) => waiting.push(r));
      active++;
    },
    release() {
      active--;
      waiting.shift()?.();
    },
  };
  return s;
}
const slots = { graphql: semaphore(12), rest: semaphore(16) };

// 遇到限流时所有请求一起暂停，不再继续撞限流
let pausedUntil = 0;
async function waitPause() {
  while (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now());
}
function pauseAll(kind, seconds, why) {
  const until = Date.now() + seconds * 1000;
  if (until > pausedUntil + 1000) log(`${why}，全部请求暂停 ${seconds} 秒`);
  pausedUntil = Math.max(pausedUntil, until);
  if (kind === 'graphql') slots.graphql.limit = Math.max(4, Math.floor(slots.graphql.limit / 2));
}

// GitHub 服务端时间，用作增量同步的时间基准，不受本机时钟影响
let serverTime = null;

async function send(kind, phase, url, init) {
  await waitPause();
  await slots[kind].acquire();
  try {
    await waitPause();
    stat(phase)[kind]++;
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    const date = Date.parse(res.headers.get('date'));
    if (!Number.isNaN(date)) serverTime = Math.max(serverTime ?? 0, date);
    return { res, text };
  } finally {
    slots[kind].release();
  }
}

// 返回重试前等待的秒数和原因；null 表示不重试。
// 网络中断、超时、5xx、499 按 2、4、8… 秒退避；额度用尽等到重置时间；二级限流按 Retry-After，没有时 60、120… 秒。
// 额度用尽：等到 x-ratelimit-reset（按 GitHub 服务端时间计算），超过 MAX_RESET_WAIT_S 就失败退出
function untilReset(res, why) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const wait = Math.ceil(reset - (serverTime ?? Date.now()) / 1000);
  if (!(wait <= MAX_RESET_WAIT_S)) throw new Error(`GitHub API 额度已用尽${Number.isFinite(reset) ? `，${new Date(reset * 1000).toISOString()} 恢复` : ''}`);
  return { seconds: Math.max(1, wait), why, limited: true };
}

function retryPlan(res, text, attempt) {
  if (!res) return { seconds: 2 ** attempt };
  if (res.status >= 500 || res.status === 499) return { seconds: 2 ** attempt, why: `HTTP ${res.status}` };
  if (res.status !== 403 && res.status !== 429) return null;
  if (res.headers.get('x-ratelimit-remaining') === '0') return untilReset(res, `额度用尽（HTTP ${res.status}）`);
  if (res.status === 429 || /rate limit/i.test(text)) {
    return { seconds: Number(res.headers.get('retry-after')) || 60 * 2 ** (attempt - 1), why: `二级限流（HTTP ${res.status}）`, limited: true };
  }
  return null;
}

async function backoff(kind, phase, plan, attempt, detail) {
  stat(phase).retries++;
  if (plan.limited) pauseAll(kind, plan.seconds, plan.why);
  else debug(`${plan.why || detail}，${plan.seconds} 秒后重试（第 ${attempt} 次）`);
  await sleep(plan.seconds * 1000);
}

function client(token) {
  // allowMissing：编号空缺（已删除、转移或属于 discussion）时 GitHub 返回 NOT_FOUND，保留其余数据。
  // 每个查询附带 rateLimit.cost，按阶段统计实际消耗的点数。
  async function gql(phase, query, variables, { allowMissing = false } = {}) {
    const body = JSON.stringify({ query: query.replace('{', '{ rateLimit { cost } '), variables });
    for (let attempt = 1; ; attempt++) {
      let res;
      let text;
      let error;
      try {
        ({ res, text } = await send('graphql', phase, GRAPHQL, {
          method: 'POST',
          headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
          body,
        }));
      } catch (err) {
        error = err;
      }
      if (res?.status === 401) throw new Error('token 无效或已过期（HTTP 401）');
      let plan = retryPlan(res, text, attempt);
      let data = null;
      if (!plan && res?.ok) {
        data = JSON.parse(text);
        const errors = data.errors || [];
        if (errors.some((e) => e.type === 'RATE_LIMITED')) {
          plan = res.headers.get('x-ratelimit-remaining') === '0' ? untilReset(res, 'GraphQL 额度用尽')
            : { seconds: 60 * 2 ** (attempt - 1), why: 'GraphQL 限流（RATE_LIMITED）', limited: true };
        }
        else if (errors.some((e) => /timeout|timed out|something went wrong/i.test(e.message))) plan = { seconds: 2 ** attempt, why: errors[0].message };
      }
      if (plan && attempt < MAX_ATTEMPTS) {
        await backoff('graphql', phase, plan, attempt, error?.message);
        continue;
      }
      if (error) throw new Error(`网络请求失败：${error.message}`);
      if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}：${text.slice(0, 200)}`);
      const errors = data.errors || [];
      const fatal = errors.filter((e) => !(allowMissing && e.type === 'NOT_FOUND'));
      if (fatal.length || !data.data) throw new Error((fatal.length ? fatal : errors).map((e) => e.message).join('；'));
      stat(phase).points += data.data.rateLimit?.cost ?? 0;
      return data.data;
    }
  }

  async function rest(phase, method, url, body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      let text;
      let error;
      try {
        ({ res, text } = await send('rest', phase, `https://api.github.com${url}`, {
          method,
          headers: {
            Authorization: `bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }));
      } catch (err) {
        error = err;
      }
      const plan = retryPlan(res, text, attempt);
      if (plan && attempt < MAX_ATTEMPTS) {
        await backoff('rest', phase, plan, attempt, error?.message);
        continue;
      }
      if (error) throw new Error(`网络请求失败：${error.message}`);
      if (!res.ok) {
        const err = new Error(`${method} ${url} 返回 HTTP ${res.status}：${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
    }
  }

  return { gql, rest };
}

// 任一任务失败后不再领取新任务；等进行中的任务结束再抛出第一个错误
async function runPool(tasks, limit) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < tasks.length && !failure) {
      const i = next++;
      try {
        await tasks[i]();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw failure;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// ---------- 缓存 ----------

// 拉取结果缓存在仓库工作区之外，下次只拉增量：
//   PR / issue：按编号缓存，按 updatedAt 找出上次同步后变动的编号重新拉取；条目数与 GitHub 不符（删除、转出）时整仓重扫。
//   默认分支 commit：按 head 缓存，head 前移时用 compare 取新增 commit 再按 GitHub 的列表顺序重排；不是前移（force-push）时整仓重列。
//   合入 PR 的改动文件、关闭 PR 的关闭人、commit 的 PR 归属与改动行：按节点 id 缓存。
// 仓库按节点 id 对应，改名后缓存照用，删除或移出组织后丢弃。
// 每次运行另外重新拉取约 1/VERIFY_SLOTS 的已缓存数据，与缓存比对并替换，VERIFY_SLOTS 次运行（每小时一次即一天）全部校验一遍。
// 缓存内容的结构或解析方式（例如 commitAuthors）改变时提升 CACHE_VERSION，旧缓存随之作废。
const CACHE_VERSION = 1;
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'contribution');
const CACHE_FILE = path.join(CACHE_DIR, `${ORG}.json`);
const VERIFY_SLOTS = 24;
// 增量同步从上次同步时间往前多看这么久，覆盖 GitHub 副本延迟
const SINCE_MARGIN_MS = 10 * 60 * 1000;
// squash、rebase 合入的 commit 关联到 PR 有延迟：提交时间在这段时间内、上次查到不属于 PR 的，每次重查
const ASSOC_RECHECK_MS = 24 * 3600 * 1000;

function loadCache() {
  if (NO_CACHE) return { cache: null, why: '--no-cache' };
  let text;
  try {
    text = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { cache: null, why: '没有缓存' };
    return { cache: null, why: `缓存无法读取：${err.message}` };
  }
  try {
    const cache = JSON.parse(text);
    if (cache.version !== CACHE_VERSION || cache.org !== ORG) return { cache: null, why: '缓存版本不符' };
    return { cache };
  } catch (err) {
    return { cache: null, why: `缓存已损坏：${err.message}` };
  }
}

// 缓存含 commit 标题、文件路径与登录名，只给本人读写；先写临时文件再改名，中途失败不会留下半个文件
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(tmp, CACHE_FILE);
}

// 字符串 id 到校验分片的映射，只需稳定、分布均匀
function slotOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % VERIFY_SLOTS;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 校验发现与缓存不符的项数，按阶段计
const addStale = (ctx, phase, n = 1) => { ctx.stale[phase] = (ctx.stale[phase] || 0) + n; };

// ---------- GitHub GraphQL ----------

// GitHub 按查询中的嵌套连接计点：连接总数 ÷ 100 后四舍五入，最少 1 点。
// PR 有 review、评论、commit 3 个嵌套连接，每批 48 个编号约 145 个连接，只计 1 点。
// commit 读提交说明再解析 Co-Authored-By：若用 authors 连接，每个 commit 多 1 个连接，点数约为 4 倍。
const NESTED_LIMIT = 20;
const COMMIT_LIMIT = 5;
const BATCH_SIZE = 48;

// 账号带上节点 id（不计点），用来发现改名、注销这类不改动 updatedAt 的变化
const ACTOR = 'login __typename ... on Node { id }';
const PR_FIELDS = `
  id number state createdAt updatedAt mergedAt closedAt additions deletions
  author { ${ACTOR} }
  mergedBy { ${ACTOR} }
  reviews(first: ${NESTED_LIMIT}) { totalCount nodes { author { ${ACTOR} } submittedAt } }
  comments(first: ${NESTED_LIMIT}) { totalCount nodes { author { ${ACTOR} } createdAt } }
  commits(last: ${COMMIT_LIMIT}) { totalCount nodes { commit { author { name } message } } }`;
const ISSUE_FIELDS = `
  number state stateReason createdAt updatedAt closedAt
  author { ${ACTOR} }
  comments(first: ${NESTED_LIMIT}) { totalCount nodes { author { ${ACTOR} } createdAt } }`;

// 成员、仓库，以及各仓库最新的 PR / issue 编号、最近更新的 PR / issue、默认分支的 head 一次取回，共 4 点。
// 最近更新的列表供增量同步：上次同步之后的变动通常在前 50 个以内，超出时再按 UPDATED_AT 翻页。
const RECENT = 50;
const META_QUERY = `query($org: String!, $memberCursor: String, $repoCursor: String, $needMembers: Boolean!, $needRepos: Boolean!) {
  organization(login: $org) {
    membersWithRole(first: 100, after: $memberCursor) @include(if: $needMembers) {
      pageInfo { hasNextPage endCursor }
      nodes { login }
    }
    repositories(first: 100, after: $repoCursor, orderBy: {field: NAME, direction: ASC}) @include(if: $needRepos) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name isArchived isFork createdAt
        pullRequests(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { number } }
        issues(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { number } }
        updatedPrs: pullRequests(first: ${RECENT}, orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage endCursor } nodes { number updatedAt } }
        updatedIssues: issues(first: ${RECENT}, orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage endCursor } nodes { number updatedAt } }
        defaultBranchRef { target { ... on Commit { oid } } }
      }
    }
  }
}`;
const UPDATED_QUERY = `query($org: String!, $repo: String!, $prCursor: String, $issueCursor: String, $needPrs: Boolean!, $needIssues: Boolean!) {
  repository(owner: $org, name: $repo) {
    updatedPrs: pullRequests(first: 100, after: $prCursor, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $needPrs) { pageInfo { hasNextPage endCursor } nodes { number updatedAt } }
    updatedIssues: issues(first: 100, after: $issueCursor, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $needIssues) { pageInfo { hasNextPage endCursor } nodes { number updatedAt } }
  }
}`;
// 变动超过这么多页（每页 100 个）时不再翻页，整仓重扫
const MAX_UPDATED_PAGES = 10;

// 关闭未合入的 PR 由谁关闭：timelineItems 是嵌套连接，只对这类 PR 单独查询，主查询每批仍是 1 点
const NODES_BATCH = 100;
const CLOSER_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { ${ACTOR} } } } } }
  }
}`;

// 合入 PR 的改动文件，供引擎按已有样式文件占比计分（changeType 区分新增与修改）：files 是嵌套连接，同样只对合入 PR 单独查询，每批 100 个 PR 计 1 点。
// 文件路径只在内存与本机缓存中参与计算，不写入 board.json。
const FILES_LIMIT = 100;
const FILES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id files(first: ${FILES_LIMIT}) { nodes { path additions deletions changeType } } }
  }
}`;

// 直接推送：默认分支的 commit 用 REST 按页列出（每页 100 个，各页并发）；GraphQL 的 history 只能按游标逐页翻，大仓库要几十分钟。
// 非合并、关联到 GitHub 账号的 commit 再用 nodes 分批查是否属于 PR：associatedPullRequests 是嵌套连接，每批 100 个计 1 点。
// 改动行服务端算得慢，只对不属于 PR 的 commit 查，每批同样计 1 点。
const COMMIT_PAGE = 100;
// compare 一次最多取这么多页（每页 100 个），再多就整仓重列
const MAX_COMPARE_PAGES = 10;
const COMMIT_PR_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Commit { id associatedPullRequests(first: 1) { totalCount } } }
}`;
const COMMIT_LINES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Commit { id additions deletions } }
}`;
// 缓存里出现过的用户账号现在的 login；改名后 id 不变，注销后查不到
const USERS_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on User { id login } }
}`;

function batchQuery(numbers) {
  const items = numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${ISSUE_FIELDS} } }`).join('\n');
  return `query($org: String!, $repo: String!) { repository(owner: $org, name: $repo) { ${items} } }`;
}

// 把提交说明里的 Co-Authored-By 转成引擎使用的 commit.authors 结构，并丢弃说明正文
const CO_AUTHOR = /^co-authored-by:\s*(.+?)\s*(?:<[^>]*>)?\s*$/gim;
function commitAuthors(author, message) {
  const names = author ? [author] : [];
  for (const m of (message || '').matchAll(CO_AUTHOR)) names.push(m[1]);
  return { commit: { authors: { nodes: names.map((name) => ({ name })) } } };
}
function normalizeItem(item) {
  if (item.__typename !== 'PullRequest' || !item.commits) return item;
  const nodes = item.commits.nodes.map(({ commit }) => commitAuthors(commit.author?.name, commit.message));
  return { ...item, commits: { totalCount: item.commits.totalCount, nodes } };
}

// 成员与参与统计的仓库；超过 100 时只对还没取完的那一项继续翻页。members 是 Promise。
async function fetchMeta(gh, org) {
  const members = [];
  const repos = [];
  const vars = { org, memberCursor: null, repoCursor: null, needMembers: true, needRepos: true };
  let syncedAt = null;
  let memberPage = null;
  while (vars.needRepos) {
    const d = (await gh.gql('meta', META_QUERY, vars)).organization;
    syncedAt ??= serverTime ?? Date.now();
    if (!d) throw new Error('找不到组织，或 token 没有访问权限');
    if (vars.needMembers) {
      members.push(...d.membersWithRole.nodes.map((m) => m.login));
      memberPage = d.membersWithRole.pageInfo;
      vars.needMembers = false;
    }
    repos.push(...d.repositories.nodes);
    vars.needRepos = d.repositories.pageInfo.hasNextPage;
    vars.repoCursor = d.repositories.pageInfo.endCursor;
  }
  // 成员只在计算时用到：超过 100 人时其余页在后台翻，不挡住条目与 commit 的拉取
  const allMembers = (async () => {
    while (memberPage.hasNextPage) {
      const d = (await gh.gql('meta', META_QUERY, { org, memberCursor: memberPage.endCursor, repoCursor: null, needMembers: true, needRepos: false })).organization;
      members.push(...d.membersWithRole.nodes.map((m) => m.login));
      memberPage = d.membersWithRole.pageInfo;
    }
    return members;
  })();
  allMembers.catch(() => {});
  const included = repos.filter((r) => (RULES.includeArchived || !r.isArchived)
    && (RULES.includeForks || !r.isFork)
    && !RULES.excludeRepos.includes(r.name));
  return {
    members: allMembers,
    syncedAt,
    repos: included.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      head: r.defaultBranchRef?.target?.oid,
      prTotal: r.pullRequests.totalCount,
      issueTotal: r.issues.totalCount,
      maxNumber: Math.max(0, r.pullRequests.nodes[0]?.number || 0, r.issues.nodes[0]?.number || 0),
      updatedPrs: r.updatedPrs,
      updatedIssues: r.updatedIssues,
    })),
  };
}

// ---------- 账号 ----------

// 对象里是否出现某个账号 id（条目、关闭人或 commit 中的任一账号字段）
function mentions(obj, ids) {
  if (!ids.size) return false;
  const text = JSON.stringify(obj);
  for (const id of ids) if (text.includes(`"id":"${id}"`)) return true;
  return false;
}

// 缓存里出现过的用户账号，login 与现在不同或已查不到的 id。改名、注销不改动条目的 updatedAt，也不移动 head。
async function changedUsers(gh, cache) {
  const known = new Map();
  const note = (a) => { if (a?.id && (a.__typename ?? a.type) === 'User') known.set(a.id, a.login); };
  for (const repo of Object.values(cache.repos)) {
    for (const it of repo.items) {
      note(it.author);
      note(it.mergedBy);
      for (const r of it.reviews?.nodes || []) note(r.author);
      for (const c of it.comments.nodes) note(c.author);
    }
    for (const c of repo.commits) note(c.author);
  }
  for (const c of Object.values(cache.closers)) note(c.actor);
  const found = await lookup(gh, 'actors', USERS_QUERY, [...known.keys()], slots.graphql.limit);
  return new Set([...known].filter(([id, login]) => found.get(id)?.login !== login).map(([id]) => id));
}

// ---------- PR 与 issue ----------

// 按编号分批取回，返回 编号 → 条目；空缺的编号不在结果里
async function fetchNumbers(gh, org, repo, numbers) {
  const found = new Map();
  await runPool(chunks(numbers, BATCH_SIZE).map((batch) => async () => {
    const d = (await gh.gql('items', batchQuery(batch), { org, repo: repo.name }, { allowMissing: true })).repository;
    for (const raw of Object.values(d)) if (raw) found.set(raw.number, normalizeItem(raw));
  }), slots.graphql.limit);
  return found;
}

// 全量：按编号扫完整个仓库（PR 与 issue 共用编号）。
// 转入的旧 issue 可能有更大的编号，且与已有编号之间有整批空档；不能把空批次当成结尾。
// 只有数量不足的仓库才遍历 issue 连接，按编号去重；通常仍只需低成本的批量查询。
async function scanRepo(gh, org, repo) {
  const numbers = Array.from({ length: repo.maxNumber }, (_, i) => i + 1);
  const items = await fetchNumbers(gh, org, repo, numbers);
  const issueCount = () => [...items.values()].filter((it) => it.__typename === 'Issue').length;
  if (issueCount() >= repo.issueTotal) return items;
  let cursor = null;
  do {
    const { repository } = await gh.gql('items', `query($org: String!, $repo: String!, $cursor: String) {
      repository(owner: $org, name: $repo) {
        issues(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { __typename ${ISSUE_FIELDS} }
        }
      }
    }`, { org, repo: repo.name, cursor });
    for (const issue of repository.issues.nodes) if (!items.has(issue.number)) items.set(issue.number, issue);
    const page = repository.issues.pageInfo;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor !== null);
  return items;
}

// 上次同步之后更新过的编号；变动太多时返回 null
async function updatedNumbers(gh, org, repo, since) {
  const numbers = new Set();
  // 列表按 updatedAt 从新到旧；读到早于 since 的就停，否则返回下一页的游标
  const take = (conn) => {
    if (!conn) return null;
    for (const n of conn.nodes) {
      if (Date.parse(n.updatedAt) < since) return null;
      numbers.add(n.number);
    }
    return conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  };
  let prs = repo.updatedPrs;
  let issues = repo.updatedIssues;
  for (let page = 0; ; page++) {
    const prCursor = take(prs);
    const issueCursor = take(issues);
    if (!prCursor && !issueCursor) return numbers;
    if (page >= MAX_UPDATED_PAGES) return null;
    const d = await gh.gql('items', UPDATED_QUERY, { org, repo: repo.name, prCursor, issueCursor, needPrs: !!prCursor, needIssues: !!issueCursor });
    prs = d.repository.updatedPrs;
    issues = d.repository.updatedIssues;
  }
}

// 按编号取得到、却不计入 totalCount 的条目数（GitHub 上确有这样的 PR）。只数 META 之前创建的，拉取期间新建的不算。
function extraCount(items, repo, syncedAt) {
  const before = [...items.values()].filter((it) => Date.parse(it.createdAt) <= syncedAt);
  return {
    pr: before.filter((it) => it.__typename === 'PullRequest').length - repo.prTotal,
    issue: before.filter((it) => it.__typename === 'Issue').length - repo.issueTotal,
  };
}

// 返回 { items: 编号 → 条目, extra, how }。有缓存时只重拉变动的编号、账号有变的条目与本次校验分片；
// 条目数与 totalCount 之差和上次全量扫描时不同（删除、转出）就整仓重扫。
async function syncItems(gh, org, repo, prev, ctx) {
  if (prev) {
    const updated = await updatedNumbers(gh, org, repo, ctx.since);
    if (updated && ctx.changedActors.size) {
      for (const it of prev.items) if (mentions(it, ctx.changedActors)) updated.add(it.number);
    }
    if (updated) {
      const items = new Map(prev.items.map((it) => [it.number, it]));
      const checks = [...items.keys()].filter((n) => n % VERIFY_SLOTS === ctx.slot && !updated.has(n));
      const fetched = await fetchNumbers(gh, org, repo, [...updated, ...checks]);
      // 校验：上次同步前就没再更新、内容却变了的条目（例如账号改名），说明 updatedAt 没覆盖到这类变动
      for (const n of checks) {
        const it = fetched.get(n);
        if (it && Date.parse(it.updatedAt) < ctx.since && !same(it, items.get(n))) addStale(ctx, 'items');
      }
      for (const n of [...updated, ...checks]) {
        if (fetched.has(n)) items.set(n, fetched.get(n));
        else items.delete(n);
      }
      const count = (type) => [...items.values()].filter((it) => it.__typename === type).length;
      const extra = { pr: count('PullRequest') - repo.prTotal, issue: count('Issue') - repo.issueTotal };
      if (same(extra, prev.extra)) return { items, extra, how: `增量（更新 ${updated.size} 个）`, updated: updated.size };
      ctx.rescans++;
      debug(`${repo.name}：缓存 PR ${count('PullRequest')} 个、issue ${count('Issue')} 个，GitHub 上 ${repo.prTotal} 个、${repo.issueTotal} 个，差值与上次全量扫描（${prev.extra.pr}、${prev.extra.issue}）不同，整仓重扫`);
    } else {
      ctx.rescans++;
      debug(`${repo.name}：上次同步后变动的 PR/issue 太多，整仓重扫`);
    }
  }
  const items = await scanRepo(gh, org, repo);
  return { items, extra: extraCount(items, repo, ctx.syncedAt), how: '全量', updated: 0 };
}

// nodes(ids) 分批查询，返回 id → 节点
async function lookup(gh, phase, query, ids, limit) {
  const found = new Map();
  await runPool(chunks(ids, NODES_BATCH).map((chunk) => async () => {
    const d = await gh.gql(phase, query, { ids: chunk }, { allowMissing: true });
    for (const n of d.nodes) if (n) found.set(n.id, n);
  }), limit);
  return found;
}

// 边收集边查询的 nodes(ids)：每凑满一批就发出，done() 时查完余下的，返回 id → 节点。并发由全局的 GraphQL 限制控制。
function streamLookup(gh, phase, query) {
  const found = new Map();
  const pending = [];
  const running = [];
  let started = null;
  const flush = (all) => {
    while (pending.length >= NODES_BATCH || (all && pending.length)) {
      started ??= performance.now();
      const p = gh.gql(phase, query, { ids: pending.splice(0, NODES_BATCH) }, { allowMissing: true }).then((d) => {
        for (const n of d.nodes) if (n) found.set(n.id, n);
      });
      p.catch(() => {});
      running.push(p);
    }
  };
  return {
    add(ids) {
      pending.push(...ids);
      flush(false);
    },
    async done() {
      flush(true);
      await Promise.all(running);
      if (started !== null) stat(phase).ms += performance.now() - started;
      return found;
    },
  };
}

// 按节点 id 缓存的查询结果（关闭人、改动文件、commit 的 PR 归属与改动行）。
// add(entries) 时，valid(cached, entry) 为真的沿用缓存，其余边收集边查询；本次校验分片里的也重查，与缓存不同的计入 ctx.stale。
// value(node, entry) 取出要缓存的值；查不到节点或值为空的不缓存，下次再查。done() 返回 { values: id → 值, queried }。
function nodeCache(gh, phase, query, prev, ctx, { valid = () => true, value }) {
  const values = {};
  const asked = new Map();
  const stream = streamLookup(gh, phase, query);
  return {
    add(entries) {
      const ids = [];
      for (const e of entries) {
        const cached = prev?.[e.id];
        const keep = cached !== undefined && valid(cached, e);
        if (keep) values[e.id] = cached;
        const check = keep && slotOf(e.id) === ctx.slot;
        if (keep && !check) continue;
        asked.set(e.id, { e, check });
        ids.push(e.id);
      }
      stream.add(ids);
    },
    async done() {
      const found = await stream.done();
      for (const [id, { e, check }] of asked) {
        const n = found.get(id);
        const v = n ? value(n, e) : null;
        if (v == null) {
          delete values[id];
          continue;
        }
        if (check && !same(values[id], v)) addStale(ctx, phase);
        values[id] = v;
      }
      return { values, queried: asked.size };
    },
  };
}

// ---------- 默认分支 commit ----------

// 只保留计算用到的字段；提交说明只留标题与 Co-Authored-By 解析出的名字
function toCommit(c) {
  return {
    sha: c.sha,
    id: c.node_id,
    parents: c.parents.map((p) => p.sha),
    date: c.commit.committer.date,
    author: c.author ? { login: c.author.login ?? null, type: c.author.type ?? null, id: c.author.node_id ?? null } : null,
    authorDate: c.commit.author.date,
    title: c.commit.message.split('\n')[0],
    names: commitAuthors(c.commit.author.name, c.commit.message).commit.authors.nodes.map((n) => n.name),
  };
}

const commitsUrl = (org, repo, page) => `/repos/${org}/${repo.name}/commits?${new URLSearchParams({ sha: repo.head, since: repo.createdAt, per_page: COMMIT_PAGE, page })}`;

// 全量：翻页固定在 head 上，拉取期间有新推送也不会错位。先取第 1 页，从 Link 头得到总页数，其余各页并发。
async function listCommits(gh, org, repo) {
  const first = await gh.rest('commits', 'GET', commitsUrl(org, repo, 1));
  const link = first.headers.get('link') || '';
  const lastLink = /<([^>]+)>;\s*rel="last"/.exec(link);
  const last = lastLink ? Number(new URL(lastLink[1]).searchParams.get('page')) : 1;
  if (!Number.isInteger(last) || (!lastLink && /rel="next"/.test(link))) throw new Error(`${repo.name}：commit 列表的 Link 头没有可用的总页数：${link}`);
  const pages = [first.data];
  await runPool(Array.from({ length: last - 1 }, (_, k) => async () => {
    pages[k + 1] = (await gh.rest('commits', 'GET', commitsUrl(org, repo, k + 2))).data;
  }), slots.rest.limit);
  return pages.flat().map(toCommit);
}

// head 从 base 前移时新增的 commit；不是前移（force-push、base 已不存在）或新增太多时返回 null
async function compareCommits(gh, org, repo, base) {
  const added = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
    let d;
    try {
      ({ data: d } = await gh.rest('commits', 'GET', `/repos/${org}/${repo.name}/compare/${base}...${repo.head}?per_page=${COMMIT_PAGE}&page=${page}`));
    } catch (err) {
      if (err.status === 404 || err.status === 422) return null;
      throw err;
    }
    if (d.status !== 'ahead' || d.total_commits > MAX_COMPARE_PAGES * COMMIT_PAGE) return null;
    added.push(...d.commits);
    if (added.length >= d.total_commits) return added;
    if (!d.commits.length) return null;
  }
  return null;
}

// 按 GitHub commit 列表的顺序排列（与 git rev-list <head> --since 相同）：按提交时间从新到旧出队，同一时间先入先出；
// 早于 since 的 commit 不列出，也不再沿它找父提交。不在 bySha 里的父提交早于 since。
function listOrder(head, since, bySha) {
  const sinceAt = Date.parse(since);
  const at = (sha) => Date.parse(bySha.get(sha).date);
  const out = [];
  const seen = new Set([head]);
  const queue = bySha.has(head) ? [head] : [];
  while (queue.length) {
    const sha = queue.shift();
    if (at(sha) < sinceAt) continue;
    out.push(sha);
    for (const p of bySha.get(sha).parents) {
      if (seen.has(p) || !bySha.has(p)) continue;
      seen.add(p);
      const t = at(p);
      let i = queue.length;
      while (i > 0 && at(queue[i - 1]) < t) i--;
      queue.splice(i, 0, p);
    }
  }
  return out;
}

// 校验分片落在这个仓库的哪几页，就重新列出这几页与缓存比对；返回不一致的 commit 数。
// 页从最旧的一端数，新 commit 加在前面时已有 commit 的分片基本不变，VERIFY_SLOTS 次运行能轮到每一页。
async function verifyCommits(gh, org, repo, commits, slot) {
  let stale = 0;
  const total = Math.ceil(commits.length / COMMIT_PAGE) || 1;
  const pages = Array.from({ length: total }, (_, k) => k + 1).filter((p) => (total - p) % VERIFY_SLOTS === slot);
  await runPool(pages.map((page) => async () => {
    const real = (await gh.rest('commits', 'GET', commitsUrl(org, repo, page))).data.map(toCommit);
    const cached = commits.slice((page - 1) * COMMIT_PAGE, page * COMMIT_PAGE);
    for (let i = 0; i < Math.max(real.length, cached.length); i++) if (!same(real[i], cached[i])) stale++;
  }), slots.rest.limit);
  return stale;
}

// 返回 { commits, how }：默认分支上仓库创建之后的 commit，按 GitHub 列表顺序
async function syncCommits(gh, org, repo, prev, ctx) {
  if (!repo.head) return { commits: [], how: '没有默认分支', added: 0 };
  let commits = null;
  let how = '';
  let added = 0;
  if (prev && prev.commits.some((c) => mentions(c, ctx.changedActors))) {
    ctx.rescans++;
    debug(`${repo.name}：commit 作者的账号改名或注销，整仓重列`);
  } else if (prev?.head === repo.head) {
    commits = prev.commits;
    how = '无新 commit';
  } else if (prev?.head) {
    const raw = await compareCommits(gh, org, repo, prev.head);
    const bySha = new Map(prev.commits.map((c) => [c.sha, c]));
    for (const c of raw || []) bySha.set(c.sha, toCommit(c));
    if (raw && bySha.has(repo.head)) {
      commits = listOrder(repo.head, repo.createdAt, bySha).map((sha) => bySha.get(sha));
      added = commits.length - prev.commits.length;
      how = `增量（compare 新增 ${raw.length} 个）`;
    } else {
      ctx.rescans++;
      debug(`${repo.name}：默认分支不是前移（force-push 或旧 head 已不存在），整仓重列`);
    }
  }
  if (commits && ctx.slot !== null) {
    const stale = await verifyCommits(gh, org, repo, commits, ctx.slot);
    if (stale) {
      addStale(ctx, 'commits', stale);
      ctx.rescans++;
      debug(`${repo.name}：commit 列表校验有 ${stale} 个不一致，整仓重列`);
      commits = null;
    }
  }
  if (!commits) {
    commits = await listCommits(gh, org, repo);
    how = '全量';
    added = prev?.commits ? commits.length - prev.commits.length : 0;
  }
  return { commits, how, added };
}

// ---------- 汇总 ----------

// 拉取全部数据。cache 为 null 时全量拉取；否则只拉增量，并校验第 cache.slot 片缓存。
// 返回引擎的输入 data、新的缓存与概况。
async function fetchAll(gh, org, cache) {
  const [meta, changedActors] = await Promise.all([
    timed('meta', () => fetchMeta(gh, org)),
    cache ? timed('actors', () => changedUsers(gh, cache)) : new Set(),
  ]);
  const ctx = {
    since: cache ? Date.parse(cache.syncedAt) - SINCE_MARGIN_MS : null,
    syncedAt: meta.syncedAt,
    changedActors,
    slot: cache ? cache.slot : null,
    stale: {},
    rescans: 0,
  };
  const prevRepo = (repo) => cache?.repos[repo.id];
  const repos = meta.repos.map((r) => ({ ...r }));

  // 关闭未合入的 PR 的关闭人：id → { closedAt, actor }，actor 为 null 表示查到了 PR 但没有关闭人。
  // 重新打开再关闭会改变 closedAt，关闭人的账号有变也重查。
  const closers = nodeCache(gh, 'closers', CLOSER_QUERY, cache?.closers, ctx, {
    valid: (c, p) => c.closedAt === p.closedAt && !mentions(c, changedActors),
    value: (n, p) => ({ closedAt: p.closedAt, actor: n.timelineItems.nodes[0]?.actor ?? null }),
  });
  // 合入 PR 的改动文件：id → files，合入后不再变化
  const files = nodeCache(gh, 'files', FILES_QUERY, cache?.files, ctx, { value: (n) => n.files });
  // commit 是否属于 PR：id → associatedPullRequests.totalCount；查不到的不存，按属于 PR 计。
  // 上次查到不属于 PR、提交时间又在上次同步前 ASSOC_RECHECK_MS 之内的重查
  const assoc = nodeCache(gh, 'commit-pr', COMMIT_PR_QUERY, cache?.assoc, ctx, {
    valid: (v, c) => !(v === 0 && Date.parse(c.at) >= Date.parse(cache.syncedAt) - ASSOC_RECHECK_MS),
    value: (n) => n.associatedPullRequests.totalCount,
  });
  // 直接推送 commit 的改动行：id → additions + deletions
  const lines = nodeCache(gh, 'commit-lines', COMMIT_LINES_QUERY, cache?.lines, ctx, { value: (n) => (n.additions || 0) + (n.deletions || 0) });

  // 非合并、关联到 GitHub 账号的 commit 是直接推送的候选
  const candidatesOf = (repo) => repo.commits.filter((c) => c.parents.length <= 1 && c.author).map((c) => ({
    repo,
    id: c.id,
    author: { login: c.author.login, __typename: c.author.type },
    at: c.date,
    same: [repo.name, c.author.login, c.authorDate, c.date, c.title].join('\n'),
    commit: { authors: { nodes: c.names.map((name) => ({ name })) } },
  }));

  // 两条线并发：条目 → 关闭人、改动文件；commit 列表 → PR 归属。一个仓库拉完就开始查它的节点，不等其他仓库。
  await Promise.all([
    timed('items', () => runPool(repos.map((repo) => async () => {
      const r = await syncItems(gh, org, repo, prevRepo(repo), ctx);
      Object.assign(repo, { items: r.items, extra: r.extra, itemsHow: r.how, updated: r.updated });
      const prs = [...r.items.values()].filter((it) => it.__typename === 'PullRequest');
      closers.add(prs.filter((p) => p.state === 'CLOSED'));
      files.add(prs.filter((p) => p.mergedAt));
    }), repos.length)),
    timed('commits', () => runPool(repos.map((repo) => async () => {
      const r = await syncCommits(gh, org, repo, prevRepo(repo), ctx);
      Object.assign(repo, { commits: r.commits, commitsHow: r.how, added: r.added });
      assoc.add(candidatesOf(repo));
    }), repos.length)),
  ]);
  const [closed, changed, linked] = await Promise.all([closers.done(), files.done(), assoc.done()]);

  const candidates = repos.flatMap(candidatesOf);
  const unlinked = candidates.filter((c) => linked.values[c.id] === 0);
  // 历史被改写过的仓库里，同一个 commit 会换个 SHA 再出现一次，副本关联不到 PR：作者、作者时间、提交时间和标题都相同的只算一份，其中一份属于 PR 就都不算。
  // squash、rebase 合入生成的 commit 有时也关联不到 PR：提交时间与本人在同仓库合入 PR 的时间相差不超过 2 秒的，视为合入时生成，不算。
  const seen = new Set(candidates.filter((c) => linked.values[c.id] !== 0).map((c) => c.same));
  const merges = new Map(repos.map((repo) => [repo, [...repo.items.values()].filter((p) => p.mergedAt).map((p) => [p.author?.login, Date.parse(p.mergedAt)])]));
  const pushed = [];
  for (const c of unlinked) {
    if (seen.has(c.same)) continue;
    seen.add(c.same);
    const t = Date.parse(c.at);
    if (!merges.get(c.repo).some(([login, at]) => login === c.author.login && Math.abs(at - t) <= 2000)) pushed.push(c);
  }
  lines.add(pushed);
  const counted = await lines.done();

  for (const repo of repos) repo.direct = [];
  for (const { repo, id, author, at, commit } of pushed) {
    repo.direct.push({ author, committedAt: at, lines: counted.values[id] ?? 0, commit });
  }
  const members = await meta.members;

  // 引擎输入：条目按编号排序；关闭人与改动文件只挂在这里，不进条目缓存
  const data = {
    org,
    members,
    repos: repos.map((repo) => {
      const list = [...repo.items.values()].sort((a, b) => a.number - b.number);
      const prs = list.filter((it) => it.__typename === 'PullRequest').map((p) => {
        const actor = closed.values[p.id]?.actor;
        const f = changed.values[p.id];
        return { ...p, ...(p.state === 'CLOSED' && actor ? { closedBy: actor } : {}), ...(p.mergedAt && f ? { files: f } : {}) };
      });
      return { name: repo.name, prs, issues: list.filter((it) => it.__typename !== 'PullRequest'), direct: repo.direct };
    }),
  };

  const next = {
    version: CACHE_VERSION,
    org,
    syncedAt: new Date(meta.syncedAt).toISOString(),
    slot: ((cache?.slot ?? -1) + 1) % VERIFY_SLOTS,
    repos: Object.fromEntries(repos.map((repo) => [repo.id, {
      name: repo.name,
      items: [...repo.items.values()].sort((a, b) => a.number - b.number),
      extra: repo.extra,
      head: repo.head ?? null,
      commits: repo.commits,
    }])),
    closers: closed.values,
    files: changed.values,
    assoc: linked.values,
    lines: counted.values,
    pages: cache?.pages ?? null,
  };

  if (changedActors.size) debug(`账号改名或注销 ${changedActors.size} 个，涉及的条目、关闭人与 commit 已重新拉取`);
  for (const repo of repos) debug(`${repo.name}：PR/issue ${repo.itemsHow}；commit ${repo.commitsHow}`);
  debug(`查询关闭人 ${closed.queried} 个、改动文件 ${changed.queried} 个、commit 归属 ${linked.queried} 个、改动行 ${counted.queried} 个；`
    + `候选 commit ${candidates.length} 个，不属于 PR 的 ${unlinked.length} 个，直接推送 ${pushed.length} 个`);
  const summary = {
    repos: repos.length,
    members: members.length,
    updated: repos.reduce((n, r) => n + r.updated, 0),
    added: repos.reduce((n, r) => n + Math.max(0, r.added), 0),
    rescans: ctx.rescans,
    stale: Object.values(ctx.stale).reduce((a, b) => a + b, 0),
    staleDetail: ctx.stale,
  };
  return { data, cache: next, summary };
}

// ---------- 输出 ----------

const round = (x, digits = 2) => (typeof x === 'number' ? Math.round(x * 10 ** digits) / 10 ** digits : x);

// 只输出人维度与组织汇总；不含仓库名、PR 编号与标题、成员名单（见 AGENTS.md）
function serialize(board) {
  return {
    schema: 1,
    org: board.org,
    now: board.now,
    generatedAt: new Date(board.now).toISOString(),
    limits: { nested: NESTED_LIMIT, commits: COMMIT_LIMIT, files: FILES_LIMIT },
    summary: board.summary,
    weeks: board.weeks,
    people: board.people.map((p) => ({
      ...p,
      bonus: round(p.bonus),
      bonusPr: round(p.bonusPr),
      bonusModel: round(p.bonusModel),
      bonusCollab: round(p.bonusCollab),
      weeksIn: round(p.weeksIn),
      rate: round(p.rate, 4),
      weekly: [...p.weekly].map(([week, score]) => [week, round(score)]),
      modelMix: [...p.modelMix.values()],
    })),
  };
}

// ---------- 发布 ----------

// git blob 的 SHA，与发布分支上的文件比对，只上传变了的文件
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// 发布分支当前的提交与文件：{ commit, tree, blobs: 路径 → blob SHA }。
// 发布分支还停在上次发布或读取的提交上时，沿用缓存里的文件表，不再读提交与目录树。
async function readPages(gh, known) {
  const base = `/repos/${PAGES_REPO}`;
  const ref = await gh.rest('publish', 'GET', `${base}/git/ref/heads/${PAGES_BRANCH}`);
  const commit = ref.data.object.sha;
  if (known?.commit === commit) return known;
  const { data: c } = await gh.rest('publish', 'GET', `${base}/git/commits/${commit}`);
  const { data: t } = await gh.rest('publish', 'GET', `${base}/git/trees/${c.tree.sha}?recursive=1`);
  const blobs = Object.fromEntries(t.tree.filter((e) => e.type === 'blob' && e.mode === '100644').map((e) => [e.path, e.sha]));
  return { commit, tree: c.tree.sha, blobs };
}

// 在发布分支上做一次快进提交；内容没变时不提交，sha 为 null
async function publish(gh, pages, files, message) {
  const base = `/repos/${PAGES_REPO}`;
  const changed = files.filter((f) => pages.blobs[f.path] !== blobSha(f.content));
  if (!changed.length) return { sha: null, pages };
  // 一律按 base64 上传，PNG 等二进制文件才能原样提交
  const entries = await Promise.all(changed.map(async (f) => {
    const { data: blob } = await gh.rest('publish', 'POST', `${base}/git/blobs`, { content: f.content.toString('base64'), encoding: 'base64' });
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const { data: tree } = await gh.rest('publish', 'POST', `${base}/git/trees`, { base_tree: pages.tree, tree: entries });
  if (tree.sha === pages.tree) return { sha: null, pages };
  const { data: commit } = await gh.rest('publish', 'POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [pages.commit] });
  await gh.rest('publish', 'PATCH', `${base}/git/refs/heads/${PAGES_BRANCH}`, { sha: commit.sha, force: false });
  const blobs = { ...pages.blobs, ...Object.fromEntries(entries.map((e) => [e.path, e.sha])) };
  return { sha: commit.sha, pages: { commit: commit.sha, tree: tree.sha, blobs } };
}

// ---------- 主流程 ----------

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('未设置 GITHUB_TOKEN，且无法通过 `gh auth token` 获取 token');
  }
}

const hhmm = (iso) => new Date(Date.parse(iso) + RULES.tzOffsetHours * 3600000).toISOString().slice(5, 16).replace('T', ' ');

// 最后一行：结果｜耗时｜请求数｜缓存方式，成功与失败格式相同，便于定时任务只取这一行
function finalLine(started, result, cacheHow) {
  const t = totals();
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  return `${result}｜耗时 ${secs} 秒｜GraphQL ${t.graphql} 次 ${t.points} 点｜REST ${t.rest} 次｜重试 ${t.retries} 次｜缓存 ${cacheHow}`;
}

async function main(started, state) {
  const token = resolveToken();
  const gh = client(token);
  const { cache, why } = await timed('cache', () => loadCache());
  state.cacheHow = cache ? '增量' : `全量（${why}）`;
  log(`开始拉取 ${ORG}${cache ? `，增量同步（上次 ${hhmm(cache.syncedAt)}，校验分片 ${cache.slot + 1}/${VERIFY_SLOTS}）` : `，全量拉取（${why}）`}`);

  const { data, cache: next, summary } = await fetchAll(gh, ORG, cache);
  if (summary.stale) state.cacheHow += `，校验发现 ${summary.stale} 项与缓存不符，已更新`;
  if (summary.stale) log(`校验：${summary.stale} 项与缓存不符，已替换（${Object.entries(summary.staleDetail).map(([k, v]) => `${PHASES[k] || k} ${v}`).join('，')}）`);
  const board = await timed('compute', () => computeBoard(data, RULES, Date.now()));
  const json = `${JSON.stringify(serialize(board))}\n`;
  const delta = cache ? `PR/issue 更新 ${summary.updated} 个，新 commit ${summary.added} 个，整仓重拉 ${summary.rescans} 次` : '全量';
  log(`拉取完成：${summary.repos} 个仓库、${summary.members} 名成员，${delta}；${board.people.length} 名贡献者，合入 PR ${board.summary.merged} 个，数据 ${(json.length / 1024).toFixed(0)} KB`);

  const files = [
    ...SITE_FILES.map((f) => ({ path: f, content: fs.readFileSync(path.join(ROOT, f)) })),
    { path: 'data/board.json', content: Buffer.from(json) },
  ];
  const publishGh = process.env.PUBLISH_TOKEN ? client(process.env.PUBLISH_TOKEN) : gh;
  let result;
  if (DRY_RUN) {
    const out = path.join(ROOT, 'dist', 'board.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    // 与发布分支比对只是提示；读不到时照常写出结果并保存缓存
    let diff;
    try {
      next.pages = await timed('publish', () => readPages(publishGh, next.pages));
      const changed = files.filter((f) => next.pages.blobs[f.path] !== blobSha(f.content)).length;
      diff = `与 ${PAGES_BRANCH} 相比${changed ? `有 ${changed} 个文件变化` : '没有变化'}`;
    } catch (err) {
      diff = `无法与 ${PAGES_BRANCH} 比对：${err.message}`;
    }
    result = `--dry-run：已写入 ${path.relative(ROOT, out)}，未发布（${diff}）`;
  } else {
    const stamp = new Date(board.now + RULES.tzOffsetHours * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    const message = `更新贡献度数据 ${stamp}（UTC+${RULES.tzOffsetHours}）`;
    let published;
    try {
      published = await timed('publish', async () => publish(publishGh, await readPages(publishGh, next.pages), files, message));
    } catch (err) {
      // 422：发布分支在本次提交期间被更新，基于最新提交重试一次
      if (err.status !== 422) throw err;
      log('发布分支已被更新，重试一次');
      published = await timed('publish', async () => publish(publishGh, await readPages(publishGh, null), files, message));
    }
    next.pages = published.pages;
    result = published.sha ? `已发布到 ${PAGES_REPO}@${PAGES_BRANCH}（${published.sha.slice(0, 7)}）` : '内容没有变化，未提交';
  }
  await timed('cache', () => saveCache(next));
  debug(phaseTable());
  log(finalLine(started, result, state.cacheHow));
}

const started = performance.now();
const state = { cacheHow: '未读取' };
main(started, state).catch((err) => {
  debug(phaseTable());
  log(finalLine(started, `失败：${err.message}`, state.cacheHow));
  process.exit(1);
});
