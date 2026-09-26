# dsh-info-sources

信息采集插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

一句话：**采集方式做成适配器，接口地址做成清单**。加一个信息来源 = 改一份 JSON；加一种采集方式 = 加一个适配器文件。
已实现两种采集方式：

- `api-get` —— HTTP GET 一个 JSON 接口，用 `select` 把任意结构映射成统一条目；
- `rss` —— GET 一个 RSS 2.0 / Atom / RSS 1.0(RDF) 订阅源，按固定映射归一化（**零依赖**，自带解析器）。

取到的条目统一归一化为
`{ sourceId, title, rank, hot?, url?, originalUrl?, origin?, publishedAt?, summary?, label? }`，
并且**默认落盘**成一份 markdown（`info_collection_<时间戳>.md`），方便后续写作、归档与人工复核。

## 清单分两层，包内只带两个示例

| 层 | 文件 | 内容 |
|---|---|---|
| 包内默认层（随包发布） | `config/sources.json` | 只有 **`aihot-daily`**（api-get）与 **`qbitai-feed`**（rss）两个示例，用来说明「一个 JSON 接口」和「一个订阅源」各怎么写 |
| 用户覆盖层（本机） | `$DSH_INFO_SOURCES` → `$DSH_HOME/info-sources.json` → `~/.dsh/info-sources.json` | 你真正在用的源放这里：按 id 覆盖包内条目、或追加新源；**升级插件不会冲掉它** |

示例两条都指向公开可用的源，装上就能跑：

- `aihot-daily` → AIHOT 日报（`GET https://aihot.news/api/v1/dailies/latest`，演示嵌套数组路径 `report.sections[].items[]` 与摘要/出处/双链接的映射）；
- `qbitai-feed` → 量子位（`https://www.qbitai.com/feed`，WordPress 原生 RSS，演示 rss 方式只要一个 url）。

> 想让包内清单也带上自己的源，就往 `config/sources.json` 的 `sources` 里加；但更推荐写进**覆盖层**——包内那份会被插件升级覆盖，覆盖层不会。
> 想在清单里「注释掉」一个源而不删除，把它整段移进顶层的 `_disabled` 数组即可（`_` 开头的键不参与解析、不校验、不采集，条目原样留在文件里，`info_sources` 会列出它们）。
> 注意 `_disabled` 只对**本层**有效：想停用包内的源，要在覆盖层的 `sources` 里写 `{ "id": "aihot-daily", "enabled": false }`。

## 工具

| 工具 | 作用 |
|---|---|
| `info_sources` | 列出清单里的源：id、采集方式、是否启用、接口地址、标签、校验问题，以及被注释掉的源有哪些 |
| `info_fetch` | 按 id 抓**一个**源；`params` 追加/覆盖查询参数（也用于 `{key}` 路径参数），`limit` 覆盖条数上限；结果默认落盘 |
| `info_collect` | 按 `ids` 或 `tag` **并行**抓多个源并汇总；`dedupe=title` 按标题合并、`sort=hot` 按热度排序；结果默认落盘 |
| `info_reload` | 强制重读清单并回报全部校验问题（改完文件/环境变量后立刻确认） |
| `info_source_save` | 用程序方式维护覆盖层：写入/更新/删除某个源的字段（如 `{"enabled": false}` 停用） |

典型用法（id 用包内示例；你自己的源放进覆盖层后换成自己的 id，`info_sources` 会列出全部可用 id）：

```
info_fetch(id="aihot-daily", limit=10)
info_fetch(id="qbitai-feed", limit=10)                                       # RSS 订阅源
info_fetch(id="aihot-daily", params={"date":"2026-09-25"})                   # 指定日期（见下面日报说明）
info_collect(tag="ai", dedupe="title", sort="hot", limit=20)                 # 全部 ai 标签源一起汇总去重
info_fetch(id="aihot-daily", path="collections/ai")                          # 落盘到指定目录
info_fetch(id="aihot-daily", path="draft/source.md")                         # 落盘到指定文件
info_fetch(id="aihot-daily", save=false)                                     # 只看不落盘
info_source_save(id="aihot-daily", patch={"enabled": false})                 # 停用某个源，改完自动重载
```

所有工具**抓取失败不抛异常**，而是返回 `ok=false` + 具体原因（HTTP 状态、超时、非 JSON、结构不匹配、未知 id…）；
`info_collect` 里单个源失败不影响其它源的结果，失败原因写进结果的 `results` 与落盘文件的「来源」小节。

## 采集结果落盘

`info_fetch` / `info_collect` 默认把读出来的信息写成一份 markdown。

- **文件名**：`info_collection_<YYYYMMDDHHmmss>.md`，时间戳是**北京时间**的抓取时刻，例如 `info_collection_20260926144749.md`。
- **目录优先级**：`path` 参数 → 环境变量 `DSH_INFO_OUTPUT_DIR` → **会话工作区**（`exec.agent.session.header.cwd`，即 `./`）→ `process.cwd()` 兜底。
- **注意**：默认目录是**会话工作区**，不是 dsh 进程的启动目录。harness 可以在任意目录启动（例如家目录），而会话工作区是会话级设置，两者常常不同；取值与内置 pwsh 工具的默认 workdir 同源。
- **`path` 语义**：以 `.md` 结尾视为文件名（按调用方意图**覆盖**）；否则视为目录，在其下生成带时间戳的文件名；相对路径按**会话工作区**解析。
- **`save=false`**：只返回结果不落盘。
- **撞名处理**：自动生成的文件名从不覆盖已有文件，同一秒内多次采集会依次退让为 `_2`、`_3`…（并发下用 `wx` 独占创建保证不互相覆盖）。
- **落盘失败不影响取数**：失败时结果里给 `fileError`，条目照常返回；成功时给 `file` 与 `fileBytes`，并在渲染文本第一行报出路径。
- **不落盘的工具**：`info_sources` / `info_reload` / `info_source_save` 只涉及清单本身，不写文件。

文件结构：

```markdown
# AIHOT 日报（aihot-daily）采集结果

> 抓取时间：2026/09/26 17:33:49（北京时间）
> 条目：15 条
> 来源 id：`aihot-daily`　采集方式：`api-get`
> 请求：https://aihot.news/api/v1/dailies/latest
> 命中字段路径：`report.sections[].items[]`

## 来源

- ✓ **AIHOT 日报**（`aihot-daily`）：15 条
  - 请求：https://aihot.news/api/v1/dailies/latest
  - 命中字段路径：`report.sections[].items[]`

## 条目（15 条）

### 01. Satya Nadella 宣布 Copilot 迄今最大更新，定位为工作新 OS

**名次**：1 ｜ **热度**：67 ｜ **分类**：ai-products

- **出处**：X：Satya Nadella (@satyanadella)
- **发布**：2026-09-25T12:05:00.000Z（北京时间 09-25 20:05）
- **原文**：https://x.com/satyanadella/status/2103455884366188544
- **站内**：https://aihot.news/items/cmugxabb31gj8rogv0mand702

**摘要**：Satya Nadella 宣布 Copilot 迄今最大更新，将其定位为覆盖每个模型、设备和任务的工作新 OS。
```

## 示例一：api-get 方式（AIHOT 日报）

包内自带 `aihot-daily` → `GET https://aihot.news/api/v1/dailies/latest`，用它演示
`select` 的嵌套数组路径（`report.sections[].items[]`）以及摘要 / 出处 / 原文链接 / 站内链接的映射写法。

AIHOT 是匿名只读、**无需 API Key** 的 AI 资讯站；字段与错误码以官方 [OpenAPI 3.1](https://aihot.news/openapi-v1.json) 为准。
它还有另外两个端点，需要时按同样写法加进清单：

| 端点 | 说明 |
|---|---|
| `GET /api/v1/items` | 精选（`mode=selected&window=24h`；`category` 可选 ai-models / ai-products / industry / paper / tip） |
| `GET /api/v1/hot-topics` | 当前热点榜，已跨信源聚合成同一事件，带 `rank` |
| `GET /api/v1/dailies/latest` | 最新日报（每天 08:00 北京时间），条目取自 `report.sections[].items[]` ← 包内示例 |

`items` 可用参数（用 `params` 传）：`window=24h|7d`、`mode=all`（公开池）、
`category=ai-models|ai-products|industry|paper|tip`、`q=关键词 2-200 字`、`limit=1..100`。

**日报取指定日期**：`aihot-daily` 的 URL 是 `/dailies/latest`。复制这条源，把 url 改成
`https://aihot.news/api/v1/dailies/{date}`，调用时 `params={"date":"2026-09-25"}` 即可（这就是 `{key}` 路径参数的用法）。

**调用节奏与合规**（官方要求，值得遵守）：

- 轮询间隔不要快于响应头的 `s-maxage`（items / hot-topics 都是 60 秒），更密只会拿到同一份缓存；
- 建议用 `ETag` + `If-None-Match` 条件请求，304 表示没变化；收到 429 严格按 `Retry-After` 退避，不要加并发重试；
- 内容里带 **AI 生成的摘要**：引用数字、政策或原话前必须用返回的**原文链接**复核（所以 `originalUrl` 单独映射）；
- 许可：个人非商业、公益非商业、组织内部使用免费；面向外部的商业产品、收费服务、客户交付、代理接口、
  数据转售、公开镜像或批量再分发**须先取得书面授权**，仅署名不构成授权。

## 示例二：rss 方式（量子位）

包内自带 `qbitai-feed` → `https://www.qbitai.com/feed`（AI 垂直媒体「量子位」的 WordPress 原生 feed，约 10 条，部分条目没有摘要）。

> 挑源经验：优先找**原生 feed**，其次才考虑 RSSHub。量子位这条就是这么找到的——
> `rsshub.app` 在部分网络下 TCP 直接不通，公共镜像对该路由又返回 503/502/404，而它自家就有 `/feed`。

feed 不是 JSON，所以没有 `select` 字段映射，采用**固定映射**（`lib/methods/rss.js`）：

| 统一字段 | 取自 | 说明 |
|---|---|---|
| `title` | `<title>` | 支持 CDATA |
| `url` | `<link>` | Atom 取 `rel=alternate`（或无 `rel`）那条的 `href` |
| `summary` | `<description>` → `<summary>` → `<content:encoded>` → `<content>` | 先解 XML 实体再剥 HTML 标签，压成一行，上限 2000 字 |
| `origin` | `<author>` → `<category domain="source">` 的文本 → feed 标题 | `dc:creator`、Atom 的 `<author><name>` 都认 |
| `publishedAt` | `<pubDate>` → `<published>` → `<updated>` → `<dc:date>` | 统一转 ISO 8601，渲染时再换算北京时间 |
| `label` | 第一个不带 `domain` 属性的 `<category>` | Atom 取 `term` 属性 |
| `hot` | — | feed 没有热度，不输出 |

仍沿用清单的通用字段：`limit`、`timeoutMs`、`headers`、`query`、url 里的 `{key}` 路径参数。
要加一个订阅源：复制 `qbitai-feed` 那条，改 `id` / `label` / `url` 即可（`method` 保持 `rss`）。

解析器是**零依赖自研**的（`lib/feed.js`）：支持 RSS 2.0 / Atom / RSS 1.0(RDF)、CDATA、命名与数字实体、
命名空间前缀（`media:`、`content:`、`dc:`）、自闭合标签、属性值里的 `>`；不做 DTD 与命名空间校验。
刻意不引第三方 XML 库，理由和「不依赖别的插件」一样：不去共享别人 `node_modules` 里的传递依赖。

## 清单怎么维护

两层合并的顺序是：**包内默认层 → 用户覆盖层**，同 id 按字段覆盖，新 id 追加。

- **同 id 覆盖**：只写 `{ "id": "aihot-daily", "enabled": false }` 就停用包内那条；写全 `id/url/select` 就是新增自定义源。
- **热重载**：文件 mtime 一变，下次调用自动重读；也可以直接 `info_reload`。**代码**改动才需要重启 dsh。
- **注释而不删除**：顶层 `_disabled` 数组（以 `_` 开头的键一律当注释忽略）。条目留在文件里可被审查/恢复，
  但不参与校验、不参与采集，也不会出现在 `info_fetch` 的可用 id 里；`info_sources` 会单独列出它们。
- **密钥不进代码**：字符串值支持 `$ENV:NAME`（必填，缺失即校验报错）与 `$ENV:NAME?`（可选，缺失就丢掉所在的请求头/参数）。
  例如 `"Cookie": "$ENV:WEIBO_COOKIE?"`，设了环境变量就带上，没设就匿名请求。
- **校验问题不静默**：未知 method、非 http 地址、缺必填环境变量、写错的字段名，都会出现在 `info_sources` / `info_reload` 的输出里。

### 一个源条目长什么样

JSON 接口（`api-get`）—— 地址、请求头、参数、字段映射全在清单里（下面是包内示例 `aihot-daily` 的实际内容）：

```json
{
  "id": "aihot-daily",
  "label": "AIHOT 日报",
  "method": "api-get",
  "tags": ["ai", "daily"],
  "url": "https://aihot.news/api/v1/dailies/latest",
  "select": {
    "items": "report.sections[].items[]",
    "title": "title",
    "summary": "summary",
    "origin": "source.name",
    "url": "links.aihot",
    "originalUrl": "links.original",
    "label": "category",
    "hot": "score",
    "rank": "rank",
    "publishedAt": "publishedAt"
  },
  "limit": 20,
  "timeoutMs": 15000,
  "note": "维护备注，会显示在 info_sources 里"
}
```

> `select` 里的键都可选（`items` 与 `title` 必填）：源里没有的字段就不写，上面把可用字段列全只是为了当字典用。
> `label` 会渲染成条目的分类，`hot` 参与 `sort=hot` 排序，`itemsFallback` 可在主路径取空时兜底结构变动。

订阅源（`rss`）—— 只要地址，字段映射是固定的（见上面「示例二」的映射表）：

```json
{
  "id": "qbitai-feed",
  "label": "量子位",
  "method": "rss",
  "tags": ["ai", "cn", "media"],
  "url": "https://www.qbitai.com/feed",
  "headers": { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
  "limit": 20,
  "note": "维护备注"
}
```

### `select` 路径语法

| 写法 | 含义 |
|---|---|
| `a.b.c` | 逐级取属性 |
| `a.b[]` | 取数组的每个元素，可串联：`report.sections[].items[]` |
| `a.b[0]` | 取第 0 个元素 |
| `itemsFallback` | 主路径取空时依次尝试的备用路径 —— 接口改结构时只改清单，不动代码 |

`url` 里的 `{key}` 是路径参数占位符，值由调用时的 `params` 提供（缺值会得到明确报错，不会发出半截请求）。
其余 `params` 并进查询串：清单 `query` 打底，调用时同名覆盖。

### 三种维护方式

1. 直接编辑覆盖层文件（`~/.dsh/info-sources.json`，人读友好，支持 `_` 注释键）
2. 让模型调 `info_source_save`（程序化写入，自动重载，适合「换个地址试试」）
3. `DSH_INFO_SOURCES=/path/to/my.json` 指向任意清单文件（多套清单切换，或随项目走）

## 加一种采集方式

采集方式的契约很小（见 `lib/methods/index.js`）：

```js
export const myMethod = {
  id: "rss",
  label: "RSS/Atom 订阅",
  summary: "解析 XML 订阅源",
  requiredKeys: ["url"],                 // 清单校验用（点号表示嵌套，如 "select.title"）
  async run(source, { signal, params, defaults }) {
    // 返回 { ok: true, status, url, items, rawCount } 或 { ok: false, status, url, error, items: [] }
    // items 元素统一为 { sourceId, title, rank, hot?, url?, originalUrl?, origin?, publishedAt?, summary?, label? }
  },
};

// lib/methods/index.js
registerMethod(myMethod);
```

工具层（`lib/index.js`）与清单层都不用改：清单里把 `method` 写成新 id 即可。
已实现：`api-get`、`rss`。预留方向：`html`（选择器抽列表/正文）、`api-post`（POST + body）。

新适配器可以直接复用公共层：`lib/http.js`（UA 轮换、超时与取消、字符集嗅探、URL 组装）、
`lib/source-util.js`（`limit` / `timeoutMs` / `headers` 三个通用字段的取值规则）、`lib/select.js`（取值路径）。

## 安装

```sh
# 本地开发：link 当前目录（把 <path> 换成本包所在目录）
dsh plugin --profile web add link:D:\WeChat-Publishing\dsh-info-sources

# 或从 git 安装（建议 pin 到一个 commit，profile 的 lockfile 才可复现）
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git
```

`dsh plugin` 会在 profile 目录里执行 pnpm，并把声明了 `dsh.bundle` 的依赖自动加进
`dsh.profile.bundles`（见 `~/.dsh/profiles/web/package.json`）。改完需要重启 dsh 或新开会话后生效。

> **`link:` 安装前先跑一次 `npm run dev:link`**：harness 只用 profile 目录解析插件的*入口*包名，
> 插件内部的 `import "@deepseek-ai/dsh-tools"` 仍按真实路径向上找 node_modules；以 `link:` 安装时
> 包的真实路径在 profile 之外，需要包内有一个指向 DSH 自带副本的 junction。
> 从 npm/git 装进 profile 的包不需要这一步（物理位置就在 `<profile>/node_modules` 下）。

## 发布

前提：包是以 **bundle** 形式被 dsh 加载的——`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
`dsh plugin add` 会据此把它登记进 `dsh.profile.bundles`。所以发布就是把这份包放到别人能装的地方。

### 0. 发布前自检（必做）

```sh
npm test                      # 断言矩阵：解析 / 清单 / 落盘 / 真接口冒烟
npm run test:resolve          # 按 profile 解析路径加载并 apply(ctx)
npm pack --dry-run            # 看清哪些文件会进包（不该有 node_modules / test / scripts）
```

关键一步是**验证打包产物在真实安装位置能跑**（不是 link，而是物理落在 `<profile>/node_modules/` 下）：
`npm pack` 后解压到隔离 profile 的 `node_modules/dsh-info-sources/`，再让 dsh 组合一次配置并 `apply(ctx)`。

### 1. 走 git（最省事，推荐）

```sh
cd dsh-info-sources
git init && git add . && git commit -m "feat: dsh-info-sources v0.1.0"
git branch -M main
git remote add origin https://github.com/tangzijie716/dsh-info-sources.git
git push -u origin main
```

别人（或你自己）安装：

```sh
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git
# 想锁版本就带上 commit：
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git#<commit>
```

### 2. 走 npm（可选）

未加 scope 的 `dsh-info-sources` 需要该名字在 npm 上没被占用；更稳的是用 scope：

```sh
npm publish --access public          # 若包名是 @tangzijie716/dsh-info-sources
dsh plugin --profile web add @tangzijie716/dsh-info-sources
```

### 3. 升级

改 `version` → 提交/推送（或 `npm publish`）→ 使用者：

```sh
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git#<new-commit>
```

`dsh plugin` 每次都会重新对齐 `dsh.profile.bundles`：依赖里有声明 `dsh.bundle` 的包自动加入，移除的自动摘掉。

### 版本与兼容性提醒

- `peerDependencies` 写的是 `@deepseek-ai/dsh-tools: "*"`，运行时由 harness 自己提供，不要把它做成 `dependencies`。
- `engines.node >= 20`：适配器用了全局 `fetch`、`AbortController`、`TextDecoder`。
- 使用者只需要安装**这一个包**；清单与代码都在包内，不需要额外的数据文件或服务。

## 本地验证

```sh
npm test                     # 等价 node test/run.mjs
npm run test:resolve         # 等价 node test/bundle-resolution.mjs
npm run dev:link             # 建立本地 @deepseek-ai/dsh-tools 解析链接
node test/try.mjs info_fetch # 手动试跑单个工具（配 $env:INFO_ARGS 传 JSON 入参）
```

`test/run.mjs` 不需要启动 harness：用假 ctx 拿到工具定义后直接调用。覆盖工具注册与 schema 编译、本地 HTTP 接口
（字段映射含摘要/出处/原文/时间、`itemsFallback`、query 合并与覆盖、`{key}` 路径参数与缺值报错、可选 `$ENV` 请求头、
limit、404、非 JSON、未知 id）、RSS/Atom/RDF 解析器单测与走 HTTP 的完整链路、覆盖层增删改、清单校验与
`_disabled` 机制、落盘（时间戳/目录优先级含**会话工作区**/显式路径/撞名退让/`save=false`）、
以及 AIHOT 日报与量子位真接口冒烟（网络不可用时只 WARN 不 FAIL）。

测试期间默认输出目录被指到临时目录（`DSH_INFO_OUTPUT_DIR`），不会往工作区丢文件。

`test/check-feeds.mjs` 是**加源前的体检工具**：批量判断一批 RSS/Atom 地址能不能当源用。它走的就是插件的
HTTP 层与解析器，所以「体检通过」等于「加成 rss 源后能取到东西」，并报出格式、条目数、字段完整度：

```sh
node test/check-feeds.mjs https://www.36kr.com/feed https://sspai.com/feed
```

> 用它的理由：同名站点不带 `www` 常常返回 SPA 的 HTML 而不是 feed（36氪 就是），这类坑只有真拉一次才看得出来。

`test/dump-source.mjs` 把**任意一个源**整份导出成一份 markdown 快照（内部用临时覆盖层放开该源的条数上限，
再用显式 `.md` 路径落盘）：

```sh
node test/dump-source.mjs qbitai-feed "D:\WeChat-Publishing\量子位-全量.md"
```

`test/bundle-resolution.mjs` 从真实 profile 目录解析插件包名并 `apply(ctx)`，走的就是 harness 加载 bundle 的那条路径，
用于确认「装上了」等于「挂载了且真的注册了工具」：

```sh
node test/bundle-resolution.mjs "C:\Users\<you>\.dsh\profiles\web"
```

> 开发期 `node_modules/@deepseek-ai/dsh-tools` 是指向 DSH 自带副本的 junction（已进 `.gitignore`），
> 用 `npm run dev:link` 重建；`link:` 方式安装时需要它，原因见上面的安装说明。

## 目录结构

```
dsh-info-sources/
  package.json           dsh.bundle.patch 指向 cordis.patch.yml；files 决定哪些文件进包
  cordis.patch.yml       insert 一行挂载插件（就是 dsh 加载的入口行）
  LICENSE                MIT
  .gitignore             node_modules / *.tgz / info_collection_*.md
  config/sources.json    包内示例清单：一个 api-get（aihot-daily）+ 一个 rss（qbitai-feed）
  lib/index.js           工具层：info_sources / info_fetch / info_collect / info_reload / info_source_save
  lib/registry.js        清单层：两层合并、校验、$ENV 插值、mtime 热重载、程序化写入、注释块识别
  lib/output.js          落盘层：info_collection_<时间戳>.md 的命名、目录解析与 markdown 组装
  lib/select.js          取值路径工具（[] / [n] / 点号路径），api-get 用
  lib/http.js            公共 HTTP 层：UA 轮换、超时/取消、字符集嗅探、URL 组装（含 {key} 路径参数）
  lib/source-util.js     公共清单字段：effectiveLimit / effectiveTimeout / mergeHeaders
  lib/feed.js            零依赖 XML + feed 解析（RSS 2.0 / Atom / RSS 1.0）
  lib/methods/api-get.js 采集方式适配器：HTTP GET + JSON + 字段映射
  lib/methods/rss.js     采集方式适配器：RSS / Atom / RDF 订阅源
  lib/methods/index.js   采集方式注册表
  scripts/link-dsh-tools.mjs  建立本地开发用的 @deepseek-ai/dsh-tools 解析链接（dev only，不随包发布）
  test/run.mjs           本地验证：假 ctx + 本地 HTTP 接口 + RSS 解析 + 落盘 + 真接口冒烟
  test/try.mjs           手动试跑单个工具（默认会落盘，可用 $env:DSH_WORKSPACE 指定会话工作区）
  test/check-feeds.mjs   加源前体检：批量判断 feed 可用性与字段完整度
  test/dump-source.mjs   把任意一个源整份导出成 markdown 快照
  test/bundle-resolution.mjs  按 profile 解析路径复现 harness 的 bundle 加载
```

> `test/` 与 `scripts/` 只在开发时用，`package.json` 的 `files` 不含它们，不会被发布出去。

## License

MIT
