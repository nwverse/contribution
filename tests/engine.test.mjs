import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const { RULES, computeBoard, weeklyScore } = vm.runInNewContext(
  `${fs.readFileSync(new URL('../engine.js', import.meta.url), 'utf8')}\n;({ RULES, computeBoard, weeklyScore })`,
);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Independent-curve scoring fixtures.
const TIME = '2026-11-03T00:00:00Z';
const author = { login: 'contributor', __typename: 'User' };
const empty = () => ({ totalCount: 0, nodes: [] });
function scorePr(number, time = TIME, model = '') {
  return {
    number, author, createdAt: time, mergedAt: time, closedAt: time,
    additions: 999, deletions: 0, reviews: empty(), comments: empty(),
    commits: { totalCount: 1, nodes: [{ commit: { authors: { nodes: [{ name: model }] } } }] },
  };
}
function scoreIssue(number, time = TIME) {
  return { number, author, createdAt: time, stateReason: null, comments: empty() };
}
function scorePerson(prs, issues = [], now = Date.parse(TIME)) {
  return computeBoard({ org: 'example', members: [], repos: [{ name: 'project', prs, issues }] }, RULES, now).people[0];
}

test('independent curves match the agreed examples and handle empty categories', () => {
  const cases = [[0, 0, 0], [20, 0, 12], [0, 10, 5], [10, 10, 12.5], [20, 10, 17],
    [20, 100, 12 + 100 / 11], [40, 10, 120 / 7 + 5], [40, 100, 120 / 7 + 100 / 11]];
  for (const [p, c, expected] of cases) close(weeklyScore(p, 0, c).bonus, expected);
});

test('more PRs or collaborations increase totals with diminishing returns and separate bounds', () => {
  for (const field of ['pr', 'collab']) {
    let previous = weeklyScore(field === 'pr' ? 0 : 20, 0, field === 'collab' ? 0 : 10);
    let previousGain = Infinity;
    for (let n = 1; n <= 200; n++) {
      const score = weeklyScore(field === 'pr' ? n : 20, 0, field === 'collab' ? n : 10);
      const gain = score.bonus - previous.bonus;
      assert.ok(gain > 0 && gain < previousGain);
      close(score[field === 'pr' ? 'collab' : 'pr'], previous[field === 'pr' ? 'collab' : 'pr']);
      assert.ok(score.pr + score.model < 30 && score.collab < 10 && score.bonus < 40);
      previous = score;
      previousGain = gain;
    }
  }
});

test('computeBoard no longer dilutes six merged PRs when collaboration increases', () => {
  const prs = Array.from({ length: 6 }, (_, i) => scorePr(i + 1));
  const before = scorePerson(prs);
  const after = scorePerson(prs, Array.from({ length: 46 }, (_, i) => scoreIssue(i + 1)));
  assert.equal(after.merged, 6);
  assert.equal(after.collab, 46);
  close(before.bonusPr, 30 * 11.4 / 41.4);
  close(after.bonusPr, before.bonusPr);
  close(after.bonusCollab, 460 / 56);
  assert.ok(after.bonus > before.bonus);
  const more = scorePerson([...prs, scorePr(7)], Array.from({ length: 46 }, (_, i) => scoreIssue(i + 1)));
  assert.ok(more.bonus > after.bonus);
  close(more.bonusCollab, after.bonusCollab);
});

test('positive and negative model adjustments stay in the PR curve and reconcile with the total', () => {
  const weightOf = (key) => RULES.models.find((m) => m.key === key).weight;
  const opus = weightOf('opus');
  const trae = weightOf('trae');
  for (const [model, weight] of [['Claude Opus', opus], ['TRAE', trae], ['', 1]]) {
    const p = scorePerson([scorePr(1, TIME, model)], [scoreIssue(1)]);
    close(p.bonusPr + p.bonusModel, 30 * (1.9 * weight) / (30 + 1.9 * weight));
    close(p.bonusModel, p.bonusPr * (weight - 1));
    close(p.bonus, p.bonusPr + p.bonusModel + p.bonusCollab);
    close([...p.weekly.values()][0], p.bonus);
  }
  const mixed = scorePerson([scorePr(1, TIME, 'Claude Opus'), scorePr(2, TIME, 'TRAE')]);
  close(mixed.bonus, 30 * (1.9 * (opus + trae)) / (30 + 1.9 * (opus + trae)));
});

test('weeks reset at Monday 00:00 UTC+8 and future actions do not contribute', () => {
  const sunday = '2026-11-08T15:59:59Z';
  const monday = '2026-11-08T16:00:00Z';
  const prs = [scorePr(1, sunday), scorePr(2, monday)];
  const issues = [scoreIssue(1, sunday), scoreIssue(2, monday)];
  const before = scorePerson(prs, issues, Date.parse(sunday));
  const after = scorePerson(prs, issues, Date.parse(monday));
  const oneWeek = 30 * 1.9 / 31.9 + 10 / 11;
  close(before.bonus, oneWeek);
  close(after.bonus, 2 * oneWeek);
  assert.equal(after.weekly.size, 2);
  for (const [, value] of after.weekly) close(value, oneWeek);
});

test('repeated comments on one thread still count as one collaboration', () => {
  const thread = scoreIssue(1);
  thread.author = { login: 'other', __typename: 'User' };
  thread.comments = { totalCount: 2, nodes: [{ author, createdAt: TIME }, { author, createdAt: TIME }] };
  const p = scorePerson([scorePr(1)], [thread]);
  assert.equal(p.collab, 1);
  close(p.bonusCollab, 10 / 11);
});

test('curve budgets come from the supplied rules', () => {
  const rules = { ...RULES, weeklyScoreCaps: { pr: 20, collab: 5 } };
  const score = weeklyScore(20, 0, 5, rules);
  close(score.pr, 10);
  close(score.collab, 2.5);
});

// Repeated collaboration activity fixtures (credit remains deduplicated).
const FIRST = '2026-08-01T12:00:00Z';
const LATEST = '2026-11-04T10:00:00Z';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const activityAuthor = { login: 'author', __typename: 'User' };
const collaborator = { login: 'collaborator', __typename: 'User' };
const comment = (createdAt, actor = collaborator) => ({ author: actor, createdAt });
const review = (submittedAt, actor = collaborator) => ({ author: actor, submittedAt });
const connection = (nodes) => ({ totalCount: nodes.length, nodes });
const activityPr = ({ reviews = [], comments = [], mergedAt = null, mergedBy = null } = {}) => ({
  number: 1, author: activityAuthor, createdAt: FIRST, mergedAt, mergedBy, closedAt: null,
  additions: 1, deletions: 0, commits: { totalCount: 1, nodes: [] },
  reviews: connection(reviews), comments: connection(comments),
});
const activityIssue = (comments) => ({
  number: 1, author: activityAuthor, createdAt: FIRST, stateReason: null, comments: connection(comments),
});
const activityData = ({ prs = [], issues = [] }) => ({
  org: 'example', members: ['author', 'collaborator'], repos: [{ name: 'project', prs, issues }],
});
const collabBonus = weeklyScore(0, 0, RULES.score.collab).bonus;
// 下面两条用例的时间在 RULES.newbie.since 之前，只测首次贡献起算的考核期，关掉补考
const NO_SINCE = { ...RULES, newbie: { ...RULES.newbie, since: null } };

for (const scenario of [
  { name: 'PR reviews', prs: [activityPr({ reviews: [review(FIRST), review(LATEST)] })] },
  { name: 'PR comments', prs: [activityPr({ comments: [comment(FIRST), comment(LATEST)] })] },
  { name: 'merging a previously reviewed PR', prs: [activityPr({ reviews: [review(FIRST)], mergedAt: LATEST, mergedBy: collaborator })], currentActive: 2 },
  { name: 'issue comments', issues: [activityIssue([comment(FIRST), comment(LATEST)])] },
]) {
  test(`repeated collaboration updates activity without repeating credit: ${scenario.name}`, () => {
    const board = computeBoard(activityData(scenario), RULES, NOW);
    const person = board.people.find((p) => p.login === collaborator.login);
    const currentWeek = board.weeks.at(-1);
    assert.equal(person.firstAt, Date.parse(FIRST));
    assert.equal(person.lastAt, Date.parse(LATEST));
    assert.equal(person.dormant, false);
    assert.equal(currentWeek.active, scenario.currentActive || 1);
    assert.equal(person.collab, 1);
    close(person.bonus, collabBonus);
    assert.equal(person.weekly.size, 1);
    assert.equal(person.weekly.has(currentWeek.start), false);
    assert.equal(person.activeWeeks, 2);
    assert.equal(person.newbie.activeWeeks, 1); // The repeat is outside the assessment window.
  });
}

test('self, bot, ignored and undated collaboration do not update activity', () => {
  const ignored = { login: 'ignored', __typename: 'User' };
  const bot = { login: 'helper[bot]', __typename: 'Bot' };
  const board = computeBoard(activityData({ prs: [activityPr({
    reviews: [review(FIRST), review(null)],
    comments: [comment(LATEST, activityAuthor), comment(LATEST, bot), comment(LATEST, ignored)],
  })] }), { ...RULES, ignoreLogins: [ignored.login] }, NOW);
  const person = board.people.find((p) => p.login === collaborator.login);
  assert.equal(person.lastAt, Date.parse(FIRST));
  assert.equal(person.dormant, true);
  assert.equal(board.people.find((p) => p.login === activityAuthor.login).lastAt, Date.parse(FIRST));
  assert.equal(board.weeks.at(-1).active, 0);
  assert.equal(board.people.length, 2);
});

test('a repeat in a second week completes the activity requirement without extra credit', () => {
  const second = '2026-08-08T12:00:00Z';
  const own = Array.from({ length: RULES.newbie.merged }, (_, i) => ({
    ...activityPr({ mergedAt: FIRST }), number: i + 2, author: collaborator,
  }));
  const before = computeBoard(activityData({ prs: [...own, activityPr({ reviews: [review(FIRST)] })] }), NO_SINCE, NOW);
  const after = computeBoard(activityData({ prs: [...own, activityPr({ reviews: [review(FIRST), review(second)] })] }), NO_SINCE, NOW);
  const person = after.people.find((p) => p.login === collaborator.login);
  const previous = before.people.find((p) => p.login === collaborator.login);
  assert.equal(previous.newbie.status, 'failed');
  assert.equal(person.newbie.status, 'passed');
  assert.equal(person.newbie.passAt, Date.parse(second));
  assert.equal(person.newbie.activeWeeks, 2);
  assert.equal(person.activeWeeks, 2);
  assert.equal(person.collab, 1);
  assert.equal(person.bonus, previous.bonus);
  assert.deepEqual(person.weekly, previous.weekly);
});

test('filing an issue still counts toward personal and assessment activity weeks', () => {
  const board = computeBoard(activityData({ issues: [activityIssue([])] }), NO_SINCE, NOW);
  const person = board.people.find((p) => p.login === activityAuthor.login);
  assert.equal(person.activeWeeks, 1);
  assert.equal(person.newbie.activeWeeks, 1);
});

// 新手考核起点：看板上线（RULES.newbie.since）前就有贡献、第一次考核期没通过的人，从 since 起再考一次。
const SINCE = Date.parse(RULES.newbie.since);
const at = (days) => new Date(SINCE + days * 86400000).toISOString();
const newbieOf = (prs, now) => scorePerson(prs, [], Date.parse(now)).newbie;
const merges = (times) => times.map((t, i) => scorePr(i + 1, t));

test('newbie: a contributor who failed before the board launched retakes from RULES.newbie.since', () => {
  const nb = newbieOf(merges([at(-60)]), at(4));
  assert.equal(nb.status, 'pending');
  assert.equal(nb.retake, true);
  assert.equal(nb.start, SINCE);
  assert.equal(nb.end, SINCE + RULES.newbie.days * 86400000);
  assert.equal(nb.merged, 0); // 上线前的合入不算进补考期
  const passed = newbieOf(merges([at(-60), at(1), at(2), at(8)]), at(9));
  assert.equal(passed.status, 'passed');
  assert.equal(passed.passAt, Date.parse(at(8)));
  assert.equal(passed.passDay, 9);
  const failed = newbieOf(merges([at(-60), at(1)]), at(RULES.newbie.days + 1));
  assert.equal(failed.status, 'failed');
});

test('newbie: a pass before the board launched is kept', () => {
  const nb = newbieOf(merges([at(-60), at(-59), at(-50)]), at(4));
  assert.equal(nb.status, 'passed');
  assert.equal(nb.retake, false);
  assert.equal(nb.passAt, Date.parse(at(-50)));
});

test('newbie: an assessment window still open at launch keeps its earlier merges', () => {
  // 首次贡献在上线前 10 天，第一次考核期还没结束：上线前的合入照算，在第一次考核期内达标即通过
  const nb = newbieOf(merges([at(-10), at(-9), at(3)]), at(4));
  assert.equal(nb.status, 'passed');
  assert.equal(nb.start, Date.parse(at(-10)));
  const open = newbieOf(merges([at(-10), at(-9)]), at(4));
  assert.equal(open.status, 'pending');
  assert.equal(open.merged, 2);
  assert.equal(open.end, Date.parse(at(20)));
  assert.equal(open.retake, false);
  // 第一次考核期到期没过，换成从 since 起的补考期；上线前的合入不带过去
  const later = newbieOf(merges([at(-10), at(-9)]), at(21));
  assert.equal(later.status, 'pending');
  assert.equal(later.retake, true);
  assert.equal(later.start, SINCE);
  assert.equal(later.merged, 0);
  const retaken = newbieOf(merges([at(-10), at(-9), at(22), at(23), at(29)]), at(29.5));
  assert.equal(retaken.status, 'passed');
  assert.equal(retaken.retake, true);
  assert.equal(retaken.passDay, 30);
});

test('newbie: a first contribution exactly at since takes the normal assessment', () => {
  const nb = newbieOf(merges([at(0), at(1), at(8)]), at(9));
  assert.equal(nb.retake, false);
  assert.equal(nb.start, SINCE);
  assert.equal(nb.status, 'passed');
  const open = newbieOf(merges([at(0)]), at(4));
  assert.equal(open.retake, false);
  assert.equal(open.status, 'pending');
  // 考核期满没过也不补考：since 当刻来的人不算「上线前来的」
  const failed = newbieOf(merges([at(0)]), at(40));
  assert.equal(failed.retake, false);
  assert.equal(failed.status, 'failed');
});

test('newbie: retake activity weeks count only from since', () => {
  // 上线前一周（at(-3)）有动作，补考期只算上线后的周
  const nb = newbieOf(merges([at(-60), at(-3), at(1), at(2)]), at(4));
  assert.equal(nb.retake, true);
  assert.equal(nb.merged, 2);
  assert.equal(nb.activeWeeks, 1);
  const two = newbieOf(merges([at(-60), at(-3), at(1), at(8)]), at(9));
  assert.equal(two.activeWeeks, 2);
  assert.equal(two.status, 'pending'); // 合入 2 个，还差 1 个
});

test('newbie: retake anomaly counts only PRs opened in the retake window', () => {
  const open = (n, t) => ({ ...scorePr(n, t), mergedAt: null, closedAt: null });
  const before = Array.from({ length: RULES.newbie.anomaly.opened }, (_, i) => open(100 + i, at(-50)));
  const nb = newbieOf([...merges([at(-60)]), ...before], at(10));
  assert.equal(nb.retake, true);
  assert.equal(nb.anomaly, false);
  const inside = Array.from({ length: RULES.newbie.anomaly.opened }, (_, i) => open(200 + i, at(1)));
  const flagged = newbieOf([...merges([at(-60)]), ...inside], at(10));
  assert.equal(flagged.retake, true);
  assert.equal(flagged.anomaly, true);
});

test('newbie: before since a failed first window does not switch to the retake window', () => {
  const nb = newbieOf(merges([at(-60)]), at(-5));
  assert.equal(nb.retake, false);
  assert.equal(nb.status, 'failed');
  assert.equal(nb.start, Date.parse(at(-60)));
  assert.equal(nb.daysLeft, 0);
});

test('newbie: contributors who arrive after the launch are unaffected', () => {
  const nb = newbieOf(merges([at(5), at(6), at(13)]), at(14));
  assert.equal(nb.retake, false);
  assert.equal(nb.start, Date.parse(at(5)));
  assert.equal(nb.status, 'passed');
});

test('newbie: since null restores the first-contribution-only assessment', () => {
  const rules = { ...RULES, newbie: { ...RULES.newbie, since: null } };
  const nb = computeBoard({ org: 'example', members: [], repos: [{ name: 'project', prs: merges([at(-60)]), issues: [] }] }, rules, Date.parse(at(4))).people[0].newbie;
  assert.equal(nb.status, 'failed');
  assert.equal(nb.retake, false);
});
