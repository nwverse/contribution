// 奶蛙形象 SVG：沿用线上看板 index.html 的绘制代码。用法 frogIcon(kind, size)。
// kind: face / egg / unhatched / tadpole / froglet / frog / laugh / cosmic
(function () {
const DEFS = '<svg id="nw-defs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
  + '<radialGradient id="nw-body" cx="38%" cy="28%" r="78%"><stop offset="0" stop-color="#ffe27a"/><stop offset="0.55" stop-color="#f6c23e"/><stop offset="1" stop-color="#e1a02a"/></radialGradient>'
  + '<radialGradient id="nw-belly" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#fff8e8"/><stop offset="1" stop-color="#ebddbd"/></radialGradient>'
  + '<radialGradient id="nw-eye" cx="40%" cy="35%" r="65%"><stop offset="0" stop-color="#8fd86a"/><stop offset="1" stop-color="#3e9b35"/></radialGradient>'
  + '<linearGradient id="nw-shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbf0"/><stop offset="1" stop-color="#e8dcc2"/></linearGradient>'
  + '</defs></svg>';
function ensureDefs() {
  if (document.getElementById('nw-defs') || !document.body) return;
  document.body.insertAdjacentHTML('afterbegin', DEFS);
}
ensureDefs();
document.addEventListener('DOMContentLoaded', ensureDefs);
const NW = { line: '#b9811b', hand: '#5e5e66', mouth: '#6b3f12', dark: '#2a1a10', pupil: '#121212', ring: '#8e7cf0', star: '#fab219' };
// 钟形身体：头窄、下身宽，头宽约为最宽处的一半
const NW_PEAR = 'M32 6C24 6 20.5 12 20.5 20C20.5 25 18 29 15.5 33.5C11.5 40.5 10.5 48 14.5 54C18 59 24.5 60.5 32 60.5C39.5 60.5 46 59 49.5 54C53.5 48 52.5 40.5 48.5 33.5C46 29 43.5 25 43.5 20C43.5 12 40 6 32 6Z';
const NW_ARM_DOWN = 'M20 28.5C15.5 32 12 38 11 43C10.6 45.4 13.6 46.4 14.6 44.4C16 40 18.4 35.4 21.6 32Z';
const NW_ARM_IN = 'M19.5 30C15 34.5 15.5 42 22 46C24 47.4 26.4 45.2 24.8 43.2C21.6 40.6 20.8 36.4 22 33Z';
const NW_ARM_UP = 'M20.5 27C15.5 24.5 10.5 19 8.8 13.8C8.2 11.8 11 10.8 12 12.7C13.8 16.7 17.2 21 22 24.5Z';
const nwFill = (d, sw = 1.2) => `<path d="${d}" fill="url(#nw-body)" stroke="${NW.line}" stroke-width="${sw}" stroke-linejoin="round"/>`;
const nwBelly = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#nw-belly)"/>`;
const nwPaw = (x, y, rx = 3, ry = 3.4, rot = 0) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${x} ${y})" fill="${NW.hand}"/>`;
const nwMirror = (svg) => `<g transform="matrix(-1 0 0 1 64 0)">${svg}</g>`;
// 左臂与手，右侧镜像
const nwArms = (path, hx, hy, rot = 0) => {
  const one = `${nwFill(path, 1.1)}${nwPaw(hx, hy, 3, 3.4, rot)}`;
  return one + nwMirror(one);
};
const nwFeet = `${nwPaw(24.5, 60.2, 5.2, 2.2)}${nwPaw(39.5, 60.2, 5.2, 2.2)}`;
const nwGreenEye = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#nw-eye)" stroke="#2f6f28" stroke-width="1"/>`
  + `<circle cx="${x + r * 0.12}" cy="${y + r * 0.12}" r="${r * 0.46}" fill="${NW.pupil}"/>`
  + `<circle cx="${x - r * 0.3}" cy="${y - r * 0.34}" r="${r * 0.22}" fill="#fff"/>`;
const nwDotEye = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${NW.pupil}"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.38}" r="${r * 0.32}" fill="#fff"/>`;
const nwSquint = (x, y) => `<path d="M${x - 3.4} ${y + 1.6}Q${x} ${y - 2.8} ${x + 3.4} ${y + 1.6}" fill="none" stroke="${NW.dark}" stroke-width="1.7" stroke-linecap="round"/>`;
const nwSmile = (x1, x2, y, depth) => `<path d="M${x1} ${y}Q${(x1 + x2) / 2} ${y + depth} ${x2} ${y}" fill="none" stroke="${NW.mouth}" stroke-width="1.6" stroke-linecap="round"/>`;
// 大笑的嘴：深色大口，上下两排白牙
function nwLaughMouth(cx, cy, w, h) {
  const half = w / 2;
  const row = (y, dir) => {
    let d = `M${cx - half * 0.78} ${y}`;
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const x = cx - half * 0.78 + (half * 1.56 * i) / n;
      d += `L${x - (half * 0.78) / n} ${y + dir * 2.4}L${x} ${y}`;
    }
    return `<path d="${d}Z" fill="#fff"/>`;
  };
  return `<path d="M${cx - half} ${cy}Q${cx} ${cy + h * 1.7} ${cx + half} ${cy}Q${cx} ${cy + h * 0.2} ${cx - half} ${cy}Z" fill="${NW.dark}"/>`
    + row(cy + h * 0.2, 1) + row(cy + h * 0.72, -1);
}
const nwSparkle = (x, y, r) => `<path d="M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z" fill="${NW.star}"/>`;

const NW_SHAPES = {
  // 标题与 favicon：大头特写
  face: `${nwFill('M32 5C17 5 8 16 8 31C8 47 18 59 32 59C46 59 56 47 56 31C56 16 47 5 32 5Z', 1.6)}${nwBelly(32, 50, 13, 7)}`
    + `${nwGreenEye(21.5, 23, 8)}${nwGreenEye(42.5, 23, 8)}${nwSmile(25, 39, 36.5, 5)}`,
  // 蛙卵：黑豆眼的小黄团从蛋壳里探出头
  egg: `${nwFill('M32 12C23.5 12 17.5 20.5 17.5 31C17.5 38 23 43 32 43C41 43 46.5 38 46.5 31C46.5 20.5 40.5 12 32 12Z')}`
    + `${nwDotEye(27, 26, 2.3)}${nwDotEye(37, 26, 2.3)}${nwSmile(29.5, 34.5, 32, 2)}`
    + '<path d="M13.5 37L18.5 33L23.5 38L28.5 32.5L33.5 38L38.5 32.5L43.5 38L48.5 33L50.5 37C50.5 50 42.5 59 32 59C21.5 59 13.5 50 13.5 37Z" fill="url(#nw-shell)" stroke="#c9b48a" stroke-width="1.2" stroke-linejoin="round"/>',
  // 未孵化：完整的灰色蛋壳，带一道裂纹
  unhatched: '<path d="M32 6C21.5 6 14 21 14 36C14 50 22 59 32 59C42 59 50 50 50 36C50 21 42.5 6 32 6Z" fill="#d9d6ce" stroke="#9a978f" stroke-width="1.4"/>'
    + '<path d="M15.5 33L21 29L26 34L31.5 28.5L37 34L42.5 29L48.5 33" fill="none" stroke="#8e8b83" stroke-width="1.8" stroke-linejoin="round"/>',
  // 蝌蚪：圆滚滚的小奶蛙脑袋加一条尾巴
  tadpole: `${nwFill('M37 36C45 29 50 40 59 32C56.5 43 47.5 47 37 43Z')}${nwFill('M27 19C17.5 19 11 26 11 34.5C11 43 18 49 27 49C36 49 43 43 43 34.5C43 26 36.5 19 27 19Z')}`
    + `${nwBelly(27, 41.5, 10.5, 6.5)}${nwGreenEye(20.5, 25.5, 4.6)}${nwGreenEye(33.5, 25.5, 4.6)}${nwSmile(24, 30, 33.5, 2.4)}`,
  // 小奶蛙：舞台站立版，小个子、黑豆眼、小鸟嘴
  froglet: `<g transform="translate(6.4 11.4) scale(0.8)">${nwFill(NW_PEAR)}${nwBelly(32, 45, 15, 13.5)}`
    + `${nwArms(NW_ARM_DOWN, 12.2, 45.4)}${nwFeet}`
    + `${nwDotEye(27, 15.5, 2.6)}${nwDotEye(37, 15.5, 2.6)}<path d="M29.4 21Q32 19.2 34.6 21Q32 24.6 29.4 21Z" fill="#3b2a1a"/></g>`,
  // 奶蛙：标准站立版，绿色鼓眼、微笑、灰色小手
  frog: `${nwFill(NW_PEAR)}${nwBelly(32, 45, 15, 13.5)}`
    + `${nwArms(NW_ARM_DOWN, 12.2, 45.4)}${nwFeet}`
    + `${nwGreenEye(25, 13.5, 5.4)}${nwGreenEye(39, 13.5, 5.4)}${nwSmile(28.5, 35.5, 22.5, 3)}`,
  // 大笑奶蛙：眯眼张大嘴，双手捂肚子
  laugh: `${nwFill(NW_PEAR)}${nwBelly(32, 45, 15, 13.5)}`
    + `${nwArms(NW_ARM_IN, 24.2, 46.4, -25)}${nwFeet}`
    + `${nwSquint(26, 13.5)}${nwSquint(38, 13.5)}${nwLaughMouth(32, 18.5, 16, 8.5)}`,
  // 宇宙奶蛙：双手高举大笑，外加星环和星星
  cosmic: `<ellipse cx="32" cy="42" rx="30" ry="7.5" transform="rotate(-12 32 42)" fill="none" stroke="${NW.ring}" stroke-width="2" opacity="0.55"/>`
    + `${nwFill(NW_PEAR)}${nwBelly(32, 45, 15, 13.5)}`
    + `${nwArms(NW_ARM_UP, 10, 11.8, 30)}${nwFeet}`
    + `${nwSquint(26, 13.5)}${nwSquint(38, 13.5)}${nwLaughMouth(32, 18.5, 16, 8.5)}`
    + `<path d="M2.6 44.8A30 7.5 -12 0 0 61.4 39.2" fill="none" stroke="${NW.ring}" stroke-width="2.2" stroke-linecap="round"/>`
    + `${nwSparkle(56, 26, 4.5)}${nwSparkle(7, 31, 3)}`,
};

function frogIcon(kind, size = 20, pos = null) {
  const at = pos ? ` x="${pos.x}" y="${pos.y}"` : '';
  return `<svg${at} width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${NW_SHAPES[kind]}</svg>`;
}
window.frogIcon = frogIcon;
window.NW_SHAPES = NW_SHAPES;
})();
