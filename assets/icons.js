// 奶蛙形象：各形态使用透明 WebP，face（品牌位）使用 favicon.svg。用法 frogIcon(kind, size, pos)。
// 外层 svg 承接 tokens.css 里 `.frog svg` 的灰化与半透明样式；传入 pos 时作为嵌套 svg 的 x/y。
(function () {
  const FORMS = new Set(['egg', 'unhatched', 'tadpole', 'froglet', 'frog', 'laugh', 'cosmic']);

  function frogIcon(kind, size = 20, pos = null) {
    const at = pos ? ` x="${pos.x}" y="${pos.y}"` : '';
    const href = kind === 'face' ? 'favicon.svg' : FORMS.has(kind) ? `assets/naiwa/${kind}.webp` : '';
    const art = href ? `<image href="${href}" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>` : '';
    return `<svg${at} width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${art}</svg>`;
  }

  window.frogIcon = frogIcon;
})();
