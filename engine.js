// 贡献度计算引擎：页面（index.html）与上传脚本（scripts/upload.mjs）共用。
// 只依赖输入数据、规则与时间，不访问网络和 DOM。
'use strict';

// 规则常量：所有阈值与系数集中在这里，页面上的规则说明也由它生成。
const RULES = {
  // 周的切分时区（UTC+8，周一 00:00 开始）
  tzOffsetHours: 8,
  // 每周最多按这么多个动作计分，超出按比例折算，对应 M-Team「做种数最多计 N 个」
  weeklyActionCap: 10,
  score: {
    // 单个合入 PR：1 + lines × log10(1 + 改动行) + commits × log2(1 + commit 数)，再乘模型系数
    lines: 0.25,
    commits: 0.15,
    // 每参与一个他人的 PR 或 issue
    collab: 1,
  },
  // 模型系数 = 1 + 档位加成 × 版本系数。各家同档按「当代旗舰 / 中端 / 轻量」对齐，没有基准测试依据，可按团队体验调整。
  modelTiers: [
    { key: 'top', label: '顶配', bonus: 0.5 },
    { key: 'flagship', label: '旗舰', bonus: 0.3 },
    { key: 'second', label: '次旗舰', bonus: 0.2 },
    { key: 'mid', label: '中端', bonus: 0.1 },
    { key: 'light', label: '轻量', bonus: 0 },
    { key: 'unknown', label: '未注明型号', bonus: 0.1, versioned: false },
    { key: 'other', label: '其他工具 / 无 AI 标注', bonus: 0, versioned: false },
  ],
  // 版本系数 = max(0, 1 − versionDecay × (系列最新版本 − 署名版本))：落后 0.4 版加成减半，落后 0.8 版不再加成。
  // 版本号在同一系列内比较（各家产品线共用版本号），新版本发布后更新 latest。
  // latest 依据 2026-11 的公开发布：Claude Opus 5.5、GPT-6.1（Sol / Terra）、Gemini 4（Argon / Carbon）、DeepSeek V4.1 Flash。
  versionDecay: 1.25,
  // 署名有型号但没有版本号时的版本系数
  unknownVersionFactor: 0.5,
  families: {
    Claude: { latest: 5.5, version: /\b(?:fable|opus|sonnet|haiku)[ -]?(\d+)(?:[.-](\d{1,2})(?!\d))?|\bclaude[ -](\d)[.-](\d)[ -](?:fable|opus|sonnet|haiku)\b/i },
    GPT: { latest: 6.1, version: /\bgpt[- ]?(\d+)(?:\.(\d{1,2}))?/i },
    Gemini: { latest: 4, version: /\bgemini[ -]?(\d+)(?:\.(\d{1,2}))?/i },
    DeepSeek: { latest: 4.1, version: /\bdeepseek[ -]?v(\d+)(?:\.(\d{1,2}))?/i },
  },
  // 按 commit 作者与共同作者（Co-Authored-By）的名字识别模型。
  // 同一个署名按列表顺序取第一个匹配，所以更具体的型号（mini、nano、Flash-Lite）排在前面；
  // 一个 PR 出现多个模型时取系数最高的。
  models: [
    { key: 'fable', family: 'Claude', short: 'Fable', label: 'Claude Fable', tier: 'top', pattern: /\bfable\b/i },
    { key: 'opus', family: 'Claude', short: 'Opus', label: 'Claude Opus', tier: 'flagship', pattern: /\bopus\b/i },
    { key: 'sonnet', family: 'Claude', short: 'Sonnet', label: 'Claude Sonnet', tier: 'mid', pattern: /\bsonnet\b/i },
    { key: 'haiku', family: 'Claude', short: 'Haiku', label: 'Claude Haiku', tier: 'light', pattern: /\bhaiku\b/i },
    { key: 'claude', family: 'Claude', short: 'Claude、Claude Code', label: 'Claude 未注明型号', tier: 'unknown', pattern: /\bclaude\b/i },
    // GPT-6 起用代号分档：Astra 旗舰 > Sol 高端 > Terra 中端 > Luna 快速；mini、nano、Instant 沿用旧档位
    { key: 'gptLight', family: 'GPT', short: 'Luna、nano、Instant', label: 'GPT Luna / nano', tier: 'light', pattern: /\b(gpt|codex)\b[\w. -]*?\b(luna|nano|instant)\b/i },
    { key: 'gptMid', family: 'GPT', short: 'Terra、mini', label: 'GPT Terra / mini', tier: 'mid', pattern: /\b(gpt|codex)\b[\w. -]*?\b(terra|mini)\b/i },
    { key: 'gptSol', family: 'GPT', short: 'Sol', label: 'GPT Sol', tier: 'flagship', pattern: /\bgpt\b[\w. -]*?\bsol\b/i },
    { key: 'gptTop', family: 'GPT', short: 'Astra、Pro', label: 'GPT Astra / Pro', tier: 'top', pattern: /\bgpt\b[\w. -]*?\b(astra|pro)\b/i },
    { key: 'gptVer', family: 'GPT', short: 'GPT-5、5.x 等无代号版本', label: 'GPT', tier: 'flagship', pattern: /\bgpt[- ]?([5-9]|\d{2,})(\.\d+)?\b/i },
    { key: 'gpt', family: 'GPT', short: 'Codex 默认署名', label: 'GPT / Codex 未注明型号', tier: 'unknown', pattern: /\b(gpt|codex|openai|chatgpt)\b/i },
    // Gemini 4 起用代号分档：Carbon 最强 > Argon 旗舰；Flash、Flash-Lite 沿用旧档位
    { key: 'geminiLite', family: 'Gemini', short: 'Flash-Lite', label: 'Gemini Flash-Lite', tier: 'light', pattern: /\bgemini\b[\w. -]*?\bflash[- ]?lite\b/i },
    { key: 'geminiFlash', family: 'Gemini', short: 'Flash', label: 'Gemini Flash', tier: 'mid', pattern: /\bgemini\b[\w. -]*?\bflash\b/i },
    { key: 'geminiTop', family: 'Gemini', short: 'Carbon、Ultra', label: 'Gemini Carbon', tier: 'top', pattern: /\bgemini\b[\w. -]*?\b(carbon|ultra)\b/i },
    { key: 'geminiPro', family: 'Gemini', short: 'Argon、Pro', label: 'Gemini Argon / Pro', tier: 'flagship', pattern: /\bgemini\b[\w. -]*?\b(argon|pro)\b/i },
    { key: 'gemini', family: 'Gemini', short: 'Gemini', label: 'Gemini 未注明型号', tier: 'unknown', pattern: /\bgemini\b/i },
    { key: 'deepseekPro', family: 'DeepSeek', short: 'Pro、Reasoner', label: 'DeepSeek Pro / Reasoner', tier: 'second', pattern: /\bdeepseek\b[\w. -]*?\b(pro|reasoner|r\d)\b/i },
    { key: 'deepseekFlash', family: 'DeepSeek', short: 'Flash、Chat', label: 'DeepSeek Flash / Chat', tier: 'mid', pattern: /\bdeepseek\b[\w. -]*?\b(flash|chat|v\d[\w.]*)\b/i },
    { key: 'deepseek', family: 'DeepSeek', short: 'DeepSeek', label: 'DeepSeek 未注明型号', tier: 'unknown', pattern: /\bdeepseek\b/i },
    { key: 'cursor', family: '其他', short: 'Cursor', label: 'Cursor', tier: 'other', pattern: /\bcursor\b/i },
    { key: 'copilot', family: '其他', short: 'Copilot', label: 'Copilot', tier: 'other', pattern: /\bcopilot\b/i },
  ],
  modelNone: { key: 'none', family: '其他', short: '无 AI 标注', label: '无 AI 标注', tier: 'other' },
  // PR 打开超过这么多天仍未合入也未关闭，算作「未收尾」
  staleOpenDays: 14,
  newbie: {
    days: 30,
    merged: 3,
    activeWeeks: 2,
    // 考核期内开 PR 数达到 opened、合入比低于 rate，标记为「新手异常」；最近 graceHours 内开的 PR 不计
    anomaly: { opened: 10, rate: 0.3, graceHours: 48 },
  },
  // 合入率警告线：已收尾 PR 数超过 resolved 时，合入率需不低于 rate
  warnLines: [
    { resolved: 10, rate: 0.6 },
    { resolved: 50, rate: 0.7 },
    { resolved: 100, rate: 0.8 },
    { resolved: 200, rate: 0.9 },
  ],
  // 等级：同时满足在组周数、魔力、协作、合入率四项才升级；合入率低于 demote 自动降一级
  levels: [
    { name: '蝌蚪', icon: 'tadpole', tagline: '通过新手考核，游进奶蛙宇宙', weeks: 0, bonus: 0, collab: 0, rate: 0, demote: null },
    { name: '小奶蛙', icon: 'froglet', tagline: '长出脚蹼，能自己蹦了', weeks: 4, bonus: 60, collab: 3, rate: 0.7, demote: 0.6 },
    { name: '奶蛙', icon: 'frog', tagline: '睁开洞悉一切的绿色大眼睛', weeks: 8, bonus: 120, collab: 10, rate: 0.8, demote: 0.7 },
    { name: '大笑奶蛙', icon: 'laugh', tagline: '哟齁齁齁，秒开战斗脸', weeks: 12, bonus: 200, collab: 25, rate: 0.85, demote: 0.75 },
    { name: '宇宙奶蛙', icon: 'cosmic', tagline: '技能超模，什么场合都能笑着收尾', weeks: 16, bonus: 300, collab: 50, rate: 0.9, demote: 0.8 },
  ],
  dormantDays: 40,
  // 达到该等级下标及以上免于冬眠标记
  dormantExemptLevel: 2,
  // 不计为有效 issue 的关闭原因
  invalidIssueReasons: ['NOT_PLANNED', 'DUPLICATE'],
  // GitHub 类型为 User、但实际是自动化的账号
  ignoreLogins: [],
  includeArchived: false,
  includeForks: false,
  // 不参与统计的仓库：看板仓库本身的 PR、issue 与数据提交都不算贡献
  excludeRepos: ['contribution'],
};

const DAY = 86400000;
const WEEK = 7 * DAY;

function weekStart(t, tzHours) {
  const offset = tzHours * 3600000;
  const days = Math.floor((t + offset) / DAY);
  // 1970-01-01 是周四，按周一为 0 计算
  const dow = (days + 3) % 7;
  return (days - dow) * DAY - offset;
}

function toTime(s) {
  return s ? Date.parse(s) : null;
}

function countUpTo(sorted, t) {
  let n = 0;
  for (const x of sorted) {
    if (x > t) break;
    n++;
  }
  return n;
}

function qualifies(level, m) {
  return m.weeks >= level.weeks && m.bonus >= level.bonus && m.collab >= level.collab && m.rate >= level.rate;
}

function prRawScore(lines, commits, rules) {
  return 1 + rules.score.lines * Math.log10(1 + lines) + rules.score.commits * Math.log2(1 + commits);
}

// 从署名中解析版本号：正则的捕获组两两一组（主版本、次版本），取第一组匹配到的
function parseVersion(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const groups = m.slice(1);
  const i = groups.findIndex((g) => g !== undefined);
  if (i < 0) return null;
  return Number(groups[i + 1] !== undefined ? `${groups[i]}.${groups[i + 1]}` : groups[i]);
}

// 单个署名的模型、版本与系数：系数 = 1 + 档位加成 × 版本系数
function modelOf(text, rules) {
  const model = rules.models.find((x) => x.pattern.test(text)) || rules.modelNone;
  const tier = rules.modelTiers.find((t) => t.key === model.tier);
  const family = rules.families[model.family];
  let version = null;
  let factor = 1;
  if (family && tier.versioned !== false) {
    version = parseVersion(text, family.version);
    factor = version === null
      ? rules.unknownVersionFactor
      : Math.min(1, Math.max(0, 1 - rules.versionDecay * (family.latest - version)));
  }
  const weight = Math.round((1 + tier.bonus * factor) * 100) / 100;
  const label = version === null ? model.label : `${model.label} ${version}`;
  return { key: version === null ? model.key : `${model.key}@${version}`, label, model, version, weight };
}

// PR 内所有 commit 作者与共同作者中系数最高的模型，系数相同取先出现的
function detectModel(pr, rules) {
  let best = null;
  for (const c of pr.commits?.nodes || []) {
    for (const a of c.commit?.authors?.nodes || []) {
      const m = modelOf(`${a.name || ''} ${a.email || ''}`, rules);
      if (m.model !== rules.modelNone && (!best || m.weight > best.weight)) best = m;
    }
  }
  return best || modelOf('', rules);
}

// data: { org, members: [login], repos: [{ name, prs: [PR node], issues: [Issue node] }] }
// 节点字段与页面 GraphQL 查询一致。返回值只依赖 data、rules、now。
function computeBoard(data, rules, now) {
  const tz = rules.tzOffsetHours;
  const cap = rules.weeklyActionCap;
  const ignore = new Set(rules.ignoreLogins);
  const members = new Set(data.members);
  const people = new Map();
  const weekActive = new Map();
  const weekMerged = new Map();
  // 合入 PR 按「型号@版本」计数：key → { label, weight, count }
  const modelCounts = new Map();

  const human = (actor) => {
    if (!actor) return null;
    if (actor.__typename === 'Bot' || /\[bot\]$/i.test(actor.login) || ignore.has(actor.login)) return null;
    return actor.login;
  };
  const get = (login) => {
    let p = people.get(login);
    if (!p) {
      p = { login, member: members.has(login), prs: [], threads: new Map(), issuesFiled: 0 };
      people.set(login, p);
    }
    return p;
  };
  // 记录一次「参与他人工作」：同一个 PR 或 issue 只算一次，取最早时间
  const touch = (actor, t, key, owner) => {
    const login = human(actor);
    if (!login || login === owner || t == null) return;
    const p = get(login);
    const prev = p.threads.get(key);
    if (prev === undefined || t < prev) p.threads.set(key, t);
  };

  const stats = { prs: 0, merged: 0, mergedReviewed: 0, mergedSelf: 0, mergedAi: 0, truncated: 0, issues: 0 };

  for (const repo of data.repos) {
    for (const pr of repo.prs) {
      stats.prs++;
      if (pr.reviews.totalCount > pr.reviews.nodes.length || pr.comments.totalCount > pr.comments.nodes.length) {
        stats.truncated++;
      }
      const owner = human(pr.author);
      const key = `${repo.name}#${pr.number}`;
      const merged = toTime(pr.mergedAt);
      const lines = pr.additions + pr.deletions;
      const commits = pr.commits?.totalCount ?? 1;
      const model = detectModel(pr, rules);
      if (owner) {
        get(owner).prs.push({
          created: toTime(pr.createdAt),
          merged,
          closed: merged ? null : toTime(pr.closedAt),
          lines,
          commits,
          model,
          raw: prRawScore(lines, commits, rules),
        });
      }
      let reviewed = false;
      for (const r of pr.reviews.nodes) {
        const login = human(r.author);
        if (login && login !== owner) reviewed = true;
        touch(r.author, toTime(r.submittedAt), key, owner);
      }
      for (const c of pr.comments.nodes) touch(c.author, toTime(c.createdAt), key, owner);
      if (merged) {
        stats.merged++;
        if (reviewed) stats.mergedReviewed++;
        if (owner && human(pr.mergedBy) === owner) stats.mergedSelf++;
        if (model.model !== rules.modelNone) stats.mergedAi++;
        const mc = modelCounts.get(model.key) || { label: model.label, weight: model.weight, count: 0 };
        mc.count++;
        modelCounts.set(model.key, mc);
        touch(pr.mergedBy, merged, key, owner);
        const w = weekStart(merged, tz);
        weekMerged.set(w, (weekMerged.get(w) || 0) + 1);
      }
    }
    for (const issue of repo.issues) {
      stats.issues++;
      const owner = human(issue.author);
      const key = `${repo.name}!${issue.number}`;
      if (owner && !rules.invalidIssueReasons.includes(issue.stateReason)) {
        const p = get(owner);
        p.threads.set(key, toTime(issue.createdAt));
        p.issuesFiled++;
      }
      for (const c of issue.comments.nodes) touch(c.author, toTime(c.createdAt), key, owner);
    }
  }

  const levels = rules.levels;
  const nb = rules.newbie;
  const result = [];

  for (const p of people.values()) {
    const mergedPrs = p.prs.filter((x) => x.merged);
    const mergedTimes = mergedPrs.map((x) => x.merged).sort((a, b) => a - b);
    const threadTimes = [...p.threads.values()].sort((a, b) => a - b);
    // 动作：合入 PR 得分拆成规模部分 pr 与模型加成 model；协作得分 collab
    const acts = [
      ...mergedPrs.map((x) => ({ t: x.merged, pr: x.raw, model: x.raw * (x.model.weight - 1), collab: 0 })),
      ...threadTimes.map((t) => ({ t, pr: 0, model: 0, collab: rules.score.collab })),
    ].sort((a, b) => a.t - b.t);
    const allTimes = [...p.prs.map((x) => x.created), ...acts.map((a) => a.t)];
    const firstAt = Math.min(...allTimes);
    const lastAt = Math.max(...allTimes);
    for (const t of allTimes) {
      const w = weekStart(t, tz);
      if (!weekActive.has(w)) weekActive.set(w, new Set());
      weekActive.get(w).add(p.login);
    }

    // 截至 t 的魔力：逐周汇总，动作数超过 cap 的周按 cap / 动作数 折算
    const scoreAt = (t) => {
      const weeks = new Map();
      for (const a of acts) {
        if (a.t > t) break;
        const w = weekStart(a.t, tz);
        let s = weeks.get(w);
        if (!s) weeks.set(w, (s = { n: 0, pr: 0, model: 0, collab: 0 }));
        s.n++;
        s.pr += a.pr;
        s.model += a.model;
        s.collab += a.collab;
      }
      const total = { pr: 0, model: 0, collab: 0, bonus: 0, weekly: new Map() };
      for (const [w, s] of weeks) {
        const k = Math.min(1, cap / s.n);
        total.pr += k * s.pr;
        total.model += k * s.model;
        total.collab += k * s.collab;
        total.weekly.set(w, k * (s.pr + s.model + s.collab));
      }
      total.bonus = total.pr + total.model + total.collab;
      return total;
    };
    const prStatsAt = (t) => {
      let merged = 0;
      let closed = 0;
      let stale = 0;
      let inflight = 0;
      for (const pr of p.prs) {
        if (pr.created > t) continue;
        if (pr.merged && pr.merged <= t) merged++;
        else if (pr.closed && pr.closed <= t) closed++;
        else if (t - pr.created > rules.staleOpenDays * DAY) stale++;
        else inflight++;
      }
      const resolved = merged + closed + stale;
      return { merged, closed, stale, inflight, resolved, rate: resolved ? merged / resolved : null };
    };

    // 新手考核：首次贡献起 nb.days 天内，各项全部达标即通过
    const end = firstAt + nb.days * DAY;
    const evalAt = Math.min(now, end);
    let passAt = null;
    const windowWeeks = new Set();
    let windowMerged = 0;
    const events = [...mergedTimes.map((t) => [t, true]), ...threadTimes.map((t) => [t, false])].sort((x, y) => x[0] - y[0]);
    for (const [t, isMerge] of events) {
      if (t > evalAt) break;
      windowWeeks.add(weekStart(t, tz));
      if (isMerge) windowMerged++;
      if (passAt === null && windowMerged >= nb.merged && windowWeeks.size >= nb.activeWeeks) passAt = t;
    }
    const openedCutoff = Math.min(evalAt - nb.anomaly.graceHours * 3600000, end);
    const opened = p.prs.filter((x) => x.created <= openedCutoff);
    const openedMerged = opened.filter((x) => x.merged && x.merged <= evalAt).length;
    const anomaly = opened.length >= nb.anomaly.opened && openedMerged / opened.length < nb.anomaly.rate;
    const newbie = {
      status: passAt ? 'passed' : now < end ? 'pending' : 'failed',
      end,
      passAt,
      passDay: passAt ? Math.floor((passAt - firstAt) / DAY) + 1 : null,
      merged: countUpTo(mergedTimes, evalAt),
      activeWeeks: windowWeeks.size,
      daysLeft: Math.max(0, Math.ceil((end - now) / DAY)),
      anomaly,
      anomalyOpened: opened.length,
      anomalyMerged: openedMerged,
    };

    // 等级：从通过考核那周起逐周回放，状态完全由历史推导
    let level = null;
    if (passAt) {
      level = 0;
      for (let w = weekStart(passAt, tz); w <= now; w += WEEK) {
        const t = Math.max(passAt, Math.min(w + WEEK - 1, now));
        const ps = prStatsAt(t);
        const m = { weeks: (t - firstAt) / WEEK, bonus: scoreAt(t).bonus, collab: countUpTo(threadTimes, t), rate: ps.rate ?? 0 };
        while (level > 0 && m.rate < levels[level].demote) level--;
        while (level + 1 < levels.length && qualifies(levels[level + 1], m)) level++;
      }
    }

    const cur = prStatsAt(now);
    const score = scoreAt(now);
    const collab = threadTimes.length;
    const weeksIn = (now - firstAt) / WEEK;
    let next = null;
    if (level !== null && level + 1 < levels.length) {
      const L = levels[level + 1];
      next = {
        level: level + 1,
        gaps: [
          weeksIn < L.weeks ? `在组 ${Math.floor(weeksIn)}/${L.weeks} 周` : null,
          score.bonus < L.bonus ? `魔力 ${Math.floor(score.bonus)}/${L.bonus}` : null,
          collab < L.collab ? `协作 ${collab}/${L.collab}` : null,
          (cur.rate ?? 0) < L.rate ? `合入率 ${Math.round((cur.rate ?? 0) * 100)}%/${Math.round(L.rate * 100)}%` : null,
        ].filter(Boolean),
      };
    }
    let warnLine = null;
    for (const line of rules.warnLines) if (cur.resolved > line.resolved) warnLine = line;
    const warn = warnLine !== null && cur.rate < warnLine.rate;
    const dormant = now - lastAt > rules.dormantDays * DAY && !(level !== null && level >= rules.dormantExemptLevel);

    // key → { label, count }
    const modelMix = new Map();
    for (const x of mergedPrs) {
      const mm = modelMix.get(x.model.key) || { label: x.model.label, count: 0 };
      mm.count++;
      modelMix.set(x.model.key, mm);
    }

    result.push({
      login: p.login,
      member: p.member,
      firstAt,
      lastAt,
      weeksIn,
      merged: mergedTimes.length,
      opened: p.prs.length,
      closedUnmerged: cur.closed,
      stale: cur.stale,
      inflight: cur.inflight,
      resolved: cur.resolved,
      rate: cur.rate,
      collab,
      issuesFiled: p.issuesFiled,
      bonus: score.bonus,
      bonusPr: score.pr,
      bonusModel: score.model,
      bonusCollab: score.collab,
      weekly: score.weekly,
      activeWeeks: score.weekly.size,
      lines: mergedPrs.reduce((n, x) => n + x.lines, 0),
      commits: mergedPrs.reduce((n, x) => n + x.commits, 0),
      modelMix,
      newbie,
      level,
      next,
      warn,
      warnLine,
      dormant,
    });
  }

  result.sort((a, b) => b.bonus - a.bonus || b.merged - a.merged || a.login.localeCompare(b.login));
  result.forEach((p, i) => { p.rank = i + 1; });

  const allWeeks = [...weekActive.keys()];
  const weeks = [];
  if (allWeeks.length) {
    for (let w = Math.min(...allWeeks); w <= weekStart(now, tz); w += WEEK) {
      weeks.push({ start: w, active: weekActive.get(w)?.size || 0, merged: weekMerged.get(w) || 0 });
    }
  }

  const count = (f) => result.filter(f).length;
  return {
    org: data.org,
    repos: data.repos.map((r) => r.name),
    now,
    people: result,
    weeks,
    inactiveMembers: [...members].filter((m) => !people.has(m)).sort((a, b) => a.localeCompare(b)),
    summary: {
      ...stats,
      models: [...modelCounts.values()].sort((a, b) => b.count - a.count),
      contributors: result.length,
      members: members.size,
      memberContributors: count((p) => p.member),
      outsiders: count((p) => !p.member),
      passed: count((p) => p.newbie.status === 'passed'),
      failed: count((p) => p.newbie.status === 'failed'),
      pending: count((p) => p.newbie.status === 'pending'),
      anomaly: count((p) => p.newbie.anomaly),
      warn: count((p) => p.warn),
      dormant: count((p) => p.dormant),
      levelCounts: levels.map((_, i) => count((p) => p.level === i)),
    },
  };
}
