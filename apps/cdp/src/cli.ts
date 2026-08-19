/** 手写参数解析(不引依赖)。用法见 HELP。 */
import type { Rect } from './chrome';
import type { SyncSettings } from '@docs-compare/core';

export interface CliOptions {
  url?: string;
  sites?: string;
  attach?: string;
  userDataDir?: string;
  headless?: boolean;
  region?: Rect;
  settings: Partial<SyncSettings>;
  selftest?: true | 'live';
}

export const HELP = `docs-compare-cdp — CDP 驱动 Chrome 的双语文档对照阅读

用法:
  docs-compare-cdp <url> [选项]        打开并平铺对照页,常驻同步(Ctrl-C 退出)
  docs-compare-cdp --selftest          自动化测试(fixture 双语站,离线)
  docs-compare-cdp --selftest=live     自动化测试(真实站点)

选项:
  --sites <path>         站点配置 JSON(默认用包内 sites.json)
  --attach <port|url>    连接已运行的 Chrome(需以 --remote-debugging-port 启动;
                         端口对本机进程可见,用完即关)
  --user-data-dir <dir>  用持久 profile 启动(默认临时 profile;登录态可累积)
  --region <l,t,w,h>     平铺区域(默认取左侧窗口当前 bounds 对半分)
  --headless             无头模式(主要供自测/CI 用)
  --no-nav               关闭同步跳转
  --no-scroll            关闭滚动同步
  --no-semantic          语义滚动退回几何比例
  --css                  开启专注 CSS 注入(默认关;CSS 在站点配置 css 字段)`;

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { settings: {} };
  const take = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`${name} 缺少参数值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      case '--sites':
        opts.sites = take(i, a);
        i++;
        break;
      case '--attach':
        opts.attach = take(i, a);
        i++;
        break;
      case '--user-data-dir':
        opts.userDataDir = take(i, a);
        i++;
        break;
      case '--region': {
        const parts = take(i, a)
          .split(',')
          .map((n) => Number.parseInt(n, 10));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error('--region 格式应为 left,top,width,height');
        }
        const [left, top, width, height] = parts;
        opts.region = { left, top, width, height };
        i++;
        break;
      }
      case '--headless':
        opts.headless = true;
        break;
      case '--no-nav':
        opts.settings.navSync = false;
        break;
      case '--no-scroll':
        opts.settings.scrollSync = false;
        break;
      case '--no-semantic':
        opts.settings.semanticScroll = false;
        break;
      case '--css':
        opts.settings.focusCss = true;
        break;
      case '--selftest':
        opts.selftest = true;
        break;
      case '--selftest=live':
        opts.selftest = 'live';
        break;
      default:
        if (a.startsWith('--')) throw new Error(`未知选项 ${a}(--help 查看用法)`);
        if (!opts.url) opts.url = a;
        else throw new Error(`多余的参数 ${a}`);
    }
  }
  return opts;
}
