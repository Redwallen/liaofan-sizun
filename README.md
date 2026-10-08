# 《了凡四训》逐句精读

一个帮助不懂文言文的读者一句一句读懂《了凡四训》的阅读网站。
电脑、平板、手机都能用，支持「添加到主屏幕」离线阅读，登录后进度与笔记多设备同步。

| 站点 | 地址 | 说明 |
| --- | --- | --- |
| 主站（Cloudflare Workers） | https://books.redwallen.cn | 带账号与云同步 |
| 静态镜像（GitHub Pages） | https://redwallen.github.io/liaofan-sizun/ | 无后端，仅本机保存 |

**账号与 [esatmock.redwallen.cn](https://esatmock.redwallen.cn) 通用**，同一套邮箱密码，登录一次两边都生效。

---

## 功能

### 阅读

- **逐句精读**：一次只显示一句原文，点「看白话」或直接点原文，才展开现代汉语翻译，读懂再进下一句。
  读完一节显示「标记本节已掌握」时，按空格即可进入下一节；在本节第一句点「上一句」，会退回上一节的最后一句。
- **通篇对照**：整节原文铺开，每句可单独点开白话，另有「全部展开 / 收起」便于复习。
- **字词注释**：人名、地名、官职、典故、冷僻字都会标红，点一下弹出解释，页面下方也有完整注释卡片。
- **心得**：每节配一段「这一节在说什么」，点出作者用意，而不是复述译文。
- **朗读**：阅读页顶部可调用浏览器内置中文语音朗读整节原文，语速在设置里调。

### 账号与同步

- **邮箱 + 密码注册登录**，与 ESAT 练习站共用同一套账号体系。
- **多设备同步**：阅读进度、已掌握标记、个人笔记登录后自动同步。
- **逐节合并，不互相覆盖**：每条记录都带修改时间，多设备之间按「每一节各自较新者胜」合并。
- **本地优先**：没登录、离线、或部署在没有后端的静态托管上时，一切照常工作。
- **首次登录自动合并**：本机已有的进度和笔记会在首次登录时合并上传，不会丢。

### 学习管理

- **进度与笔记**：读到哪、哪些句子看过、自己写的笔记，可「标记已掌握」并汇总总进度。首页给出两个续读入口：「继续上次」回到上次打开的一节，「读得最远」直接跳到读过的、全书顺序最靠后的一节。
- **全文搜索**：可搜原文、译文、注释与人名，例如「立命」「云谷」「谦虚」。
- **字词总表**：全书 968 条注释按词语排序，可按篇筛选。
- **我的笔记**：集中查看和跳回自己写过的每一段笔记。

### 手机适配

- **底部标签栏**：目录 / 字词 / 笔记 / 设置固定在屏幕底部，拇指可及，点击区域不小于 44px。
- **底部操作条**：逐句精读时，上一句 / 看白话（或下一句）固定在**白色阅读卡片之外的屏幕底部**，始终可见，单手就能读完一节。
- **左右滑动**：左滑展开白话或进下一句，右滑回上一句（本节第一句时退回上一节）；纵向滚动和在按钮上滑动不会误触发。
- **安全区域**：处理了 iPhone 刘海与底部横条的 `safe-area-inset`。
- **PWA**：带 manifest 与 Service Worker，可添加到主屏幕、离线阅读（`/api/*` 永不缓存）。

### 其他

- 纸白 / 米黄 / 夜读三种主题，四档字号，原文可切换**竖排**（自右向左）。
- 进度与笔记未登录时存在浏览器 `localStorage`，登录后以账号为准。

---

## 内容规模

全书四篇，原文经脚本逐字校验，与公版 EPUB 源文完全一致。

| 篇 | 节数 | 句数 |
| --- | --- | --- |
| 一、立命之学 | 57 | 143 |
| 二、改过之法 | 23 | 59 |
| 三、积善之方 | 68 | 225 |
| 四、谦德之效 | 21 | 66 |
| **合计** | **169** | **493** |

另含 970 条字词注释，169 节全部配有心得。

---

## 架构

```
浏览器（books.redwallen.cn）
  ├── 静态资源：index.html / css / js / data / icons   →  Workers Static Assets
  └── /api/*    →  Worker
                    ├── /api/auth/*    复用 ESAT 的 users / sessions 表
                    └── /api/reading   本项目的 lf_progress / lf_notes 表
                              ↓
                 D1 数据库 esat-account-data（与 ESAT 共用一个库）
```

**单点登录怎么实现的**：两个站点绑定同一个 D1 数据库，会话 Cookie 同名
（`esat_session`）且都写到共享域 `Domain=.redwallen.cn`。
浏览器只接受来自 `redwallen.cn` 或其子域的响应设置该 Cookie，
所以两个站点都必须挂在 `redwallen.cn` 的子域下。
任一站点登录后，另一边读到的是同一条 `sessions` 记录，因此无需再次登录。

**密码哈希**：PBKDF2-SHA-256、10 万次迭代、每人 16 字节随机盐、输出 32 字节。
两边的实现必须完全一致，否则无法互相登录。

---

## 目录结构

```
.
├── index.html              页面骨架
├── manifest.webmanifest    PWA 清单
├── sw.js                   Service Worker（离线缓存，跳过 /api/*）
├── wrangler.jsonc          线上配置（含 books.redwallen.cn 自定义域名）
├── wrangler.dev.jsonc      本地开发配置（去掉自定义域名，避免 Cookie 被浏览器拒绝）
├── package.json            构建 / 建表 / 部署脚本
├── worker/index.js         Worker：账号认证 + 阅读数据同步
├── schema/liaofan.sql      本项目在共享库里新建的两张表
├── css/style.css           样式（含手机端适配）
├── js/
│   ├── sync.js             账号 API 与同步引擎
│   └── app.js              应用逻辑（无依赖）
├── data/                   book.js（页面加载）/ book.json
├── content/                内容源文件（改内容改这里）
├── source/                 从 EPUB 提取的原文，用于校对
├── icons/                  图标（由脚本生成）
└── tools/
    ├── build.py            合并 content/*.json → data/book.js，并校验原文
    ├── build_site.py       组装 dist/（给 Workers 托管）
    └── make_icons.py       生成 PWA / apple-touch-icon / favicon
```

---

## 本地开发

```bash
npm install
python3 tools/build_site.py                 # 组装 dist/
npx wrangler d1 execute DB --local -c wrangler.dev.jsonc --file=../ESAT/migrations/0001_accounts.sql
npx wrangler d1 execute DB --local -c wrangler.dev.jsonc --file=../ESAT/migrations/0002_password_parameters.sql
npx wrangler d1 execute DB --local -c wrangler.dev.jsonc --file=./schema/liaofan.sql
npm run dev                                  # 用 wrangler.dev.jsonc
```

纯前端调试（不需要账号功能）直接双击 `index.html` 或起个静态服务器即可。

## 部署

```bash
npm install
npm run db:init    # 在共享库里建 lf_progress / lf_notes（可重复执行）
npm run deploy     # 组装 dist/ 并 wrangler deploy
```

`npm run deploy:ci` 会把建表、组装、部署串成一步，适合 Cloudflare Workers Builds。

> 因为与 ESAT 共用同一个 D1 数据库，这里**刻意不使用 `wrangler d1 migrations`**：
> 迁移记录表是数据库级别的，两个项目各自维护会冲突。
> 改用 `schema/liaofan.sql` 里的 `CREATE TABLE IF NOT EXISTS`，重复执行安全。

## 修改内容后重新构建

```bash
python3 tools/build.py        # 合并内容并校验原文完整性
python3 tools/make_icons.py   # 需要改图标时再跑
python3 tools/build_site.py   # 重新组装 dist/
```

> 改了 `index.html` / `css` / `js` / `data` 之后，请把 `sw.js` 顶部的 `VERSION` 加一，
> 否则已装到主屏幕的设备会继续用旧缓存。

---

## 数据结构

内容见 `content/_TEMPLATE.json`；服务端见 `schema/liaofan.sql`。

一节（section）：

| 字段 | 说明 |
| --- | --- |
| `id` | 由构建脚本按篇重排，无需手写 |
| `title` | 这一节的小标题 |
| `pairs` | 逐句对照数组，每项 `{ orig, trans }` |
| `notes` | 注释数组，每项 `{ term, explain }`；`term` 会在原文中自动标红 |
| `insight` | 这一节的心得 |

同步接口（`/api/reading`）：

| 方法 | 说明 |
| --- | --- |
| `GET` | 取回该用户全部进度与笔记 |
| `POST` | 提交增量，服务端逐节按 `updatedAt` 取较新者，并回传合并后的完整状态 |
| `DELETE` | 清除该用户的全部进度与笔记 |

笔记用「空文本墓碑」表示删除：否则另一台还留着旧笔记的设备会把它传回来。

---

## 说明

- 白话翻译与注释由 AI 依据原文撰写，并经过抽样核对，建议作学习辅助使用。
- 未登录时数据只存在访问者自己的浏览器里；登录后同步到 Cloudflare D1。
- 《了凡四训》原文为明代作品，属公有领域；本项目的代码以 MIT 协议开源，详见 `LICENSE`。
