/**
 * 核心逻辑冒烟测试(无测试框架依赖):
 *   npm test --workspace @docs-compare/core
 * 由 esbuild 打包后用 node 执行,便于在任何实现改动 core 时快速回归。
 */
import { AnchorIndex } from '../src/anchors';
import { parseSites } from '../src/config';
import { PageIndex } from '../src/pages';
import { findBracket, interpAt, scrollRatio, scrollTopFor } from '../src/scroll';
import { logicalPath, mapUrl, normalizePathKey } from '../src/url';
import type { SitePair } from '../src/types';

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`FAIL  ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}

const sites: SitePair[] = [
  {
    id: 'gh-pages',
    origin: 'https://example.dev/docs/',
    mirror: 'https://you.github.io/my-zh/',
    originPrefix: '/guide',
    css: { origin: 'a{}' },
  },
  { id: 'plain', origin: 'https://plain.dev', mirror: 'https://zh.plain.dev' },
];

console.log('logicalPath / mapUrl');
eq(logicalPath('https://example.dev/docs/guide/quick/start.html', sites[0], 'origin'), '/quick/start.html', '原站:base+prefix 剥离');
eq(logicalPath('https://you.github.io/my-zh/quick/start', sites[0], 'mirror'), '/quick/start', '镜像:base 含仓库路径');
eq(logicalPath('https://example.dev/other', sites[0], 'origin'), null, '前缀不匹配 → null');
eq(logicalPath('https://plain.dev/a/b', sites[1], 'origin'), '/a/b', '无前缀站点');

const m1 = mapUrl('https://example.dev/docs/guide/learn/hooks#tips', sites);
eq(m1?.url, 'https://you.github.io/my-zh/learn/hooks', '原站 → 镜像(丢弃 hash)');
const m2 = mapUrl('https://you.github.io/my-zh/learn/hooks', sites);
eq(m2?.url, 'https://example.dev/docs/guide/learn/hooks', '镜像 → 原站');
eq(mapUrl('https://unknown.dev/x', sites), null, '未知站点 → null');

console.log('PageIndex / mapUrl 页面路径映射');
const flatSite: SitePair = {
  id: 'flat',
  origin: 'https://aihero.dev/skills',
  mirror: 'https://you.github.io/mp-zh',
};
const pi = PageIndex.fromRaw({ '/engineering/ask-matt': '/skills-ask-matt' });
const p1 = mapUrl('https://you.github.io/mp-zh/engineering/ask-matt', [flatSite], { pageIndex: pi });
eq(p1?.url, 'https://aihero.dev/skills-ask-matt', '镜像分组路径 → 原站扁平完整路径');
eq(p1?.logicalPath, '/engineering/ask-matt', 'logicalPath 统一为镜像侧(锚点表键)');
const p2 = mapUrl('https://aihero.dev/skills/skills-ask-matt', [flatSite], { pageIndex: pi });
eq(p2?.url, 'https://you.github.io/mp-zh/engineering/ask-matt', '原站扁平路径 → 镜像分组路径');
eq(p2?.logicalPath, '/engineering/ask-matt', 'origin 侧 logicalPath 亦归到镜像路径');
const p3 = mapUrl('https://you.github.io/mp-zh/other/page', [flatSite], { pageIndex: pi });
eq(p3?.url, 'https://aihero.dev/skills/other/page', '未入表路径退回逻辑路径直映');
eq(mapUrl('https://you.github.io/mp-zh/engineering/ask-matt', [flatSite])?.url, 'https://aihero.dev/skills/engineering/ask-matt', '无 pageIndex 时退回旧行为');
// 真实形态:原站扁平页是 base 的兄弟路径,前缀剥离认不出,靠表识别
const p4 = mapUrl('https://aihero.dev/skills-ask-matt', [flatSite], { pageIndex: pi });
eq(p4?.url, 'https://you.github.io/mp-zh/engineering/ask-matt', '原站兄弟路径(base 外)→ 镜像分组路径');
eq(p4?.logicalPath, '/engineering/ask-matt', '兄弟路径命中 logicalPath 归镜像侧');
eq(mapUrl('https://aihero.dev/skills-ask-matt', [flatSite]), null, '无 pageIndex 时兄弟路径不可识别(null)');

console.log('normalizePathKey');
eq(normalizePathKey('/a/b/'), '/a/b', '去尾斜杠');
eq(normalizePathKey('/a/index.html'), '/a', 'index.html → 目录');
eq(normalizePathKey('/a/b.html'), '/a/b', '剥 .html');

console.log('AnchorIndex');
const idx = AnchorIndex.fromRaw({
  '/learn/hooks': { '安装-react': 'installing-react', '使用钩子': 'using-hooks' },
  '/learn/hooks/': { '使用钩子': 'using-hooks' },
});
eq(idx.lookup('/learn/hooks', '#安装-react', 'toOrigin'), 'installing-react', 'mirror→origin');
eq(idx.lookup('/learn/hooks', 'installing-react', 'toMirror'), '安装-react', 'origin→mirror');
eq(idx.lookup('/learn/hooks/', '使用钩子', 'toMirror'), '使用钩子', '路径键归一化(尾斜杠)');
eq(idx.lookup('/learn/hooks', 'tips', 'toOrigin'), 'tips', '查不到 → 原样透传');
eq(idx.lookup('/learn/hooks', 'tips', 'toOrigin', { fallbackToSame: false }), null, '关闭透传 → null');
eq(idx.size, 2, 'size');

console.log('parseSites');
const parsed = parseSites([
  { id: 'a', origin: 'https://a.dev/', mirror: 'https://b.github.io/a/' },
  { id: 'a', origin: 'https://x.dev', mirror: 'https://y.github.io/x' },
  { id: 'bad', origin: 'notaurl', mirror: 'https://z.dev' },
]);
eq(parsed.sites.length, 1, '非法/重复项被跳过');
eq(parsed.sites[0].origin, 'https://a.dev', 'base 尾斜杠被规范');
eq(parsed.errors.length, 2, '报出全部错误');

console.log('scroll');
eq(scrollRatio({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }), 0, '顶部 → 0');
eq(scrollRatio({ scrollTop: 750, scrollHeight: 2000, clientHeight: 500 }), 0.5, '中部 → 0.5');
eq(scrollTopFor({ scrollTop: 0, scrollHeight: 4000, clientHeight: 500 }, 0.5), 1750, '按比例映射到对侧');

console.log('findBracket / interpAt(语义滚动)');
const offs = [100, 500, 900];
eq(findBracket(offs, 50), { index: -1, frac: 0.5 }, '首个锚点前');
eq(findBracket(offs, 100), { index: 0, frac: 0 }, '恰在首个锚点');
eq(findBracket(offs, 300), { index: 0, frac: 0.5 }, '第一区间中点');
eq(findBracket(offs, 700), { index: 1, frac: 0.5 }, '第二区间中点');
eq(findBracket(offs, 9000), { index: 2, frac: 1 }, '尾段钳到 1');
eq(findBracket([], 100), { index: -1, frac: 0 }, '无锚点');
eq(interpAt(offs, 1, 0.5), 700, '插值还原第二区间中点');
eq(interpAt(offs, 2, 1), 1500, '尾段插值(tail=600)');
eq(interpAt(offs, 2, 0.5), 1200, '尾段中点');
// 语义往返:同一位置 findBracket → interpAt 应还原
for (const y of [120, 480, 640, 899, 1400]) {
  const b = findBracket(offs, y);
  if (b.index >= 0) eq(Math.round(interpAt(offs, b.index, b.frac)), Math.min(y, 1500), `往返还原 y=${y}`);
}

if (failed > 0) {
  console.error(`\n${failed} 个断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
