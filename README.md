# dsh-info-sources

`dsh-info-sources` 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的信息采集插件。它将采集方式封装为适配器，将信息源保存为 JSON 清单，并把不同来源的数据归一化为统一结构。

## 功能特性

- `api-get`：请求 JSON API，并通过字段路径映射数据；
- `rss`：解析 RSS 2.0、Atom 和 RSS 1.0/RDF；
- 多源并行采集、按标题去重、按热度排序；
- 包内默认源与显式用户覆盖层；
- 配置校验、环境变量插值和文件热重载；
- 默认生成 Markdown 采集报告；
- HTTP、解析和单源失败均返回结构化结果。

## 运行要求

- Node.js 20 或更高版本；
- DeepSeek Harness；
- 由 Harness 提供的 `@deepseek-ai/dsh-tools`。

## 安装

建议固定到具体 Git 提交，以获得可复现的安装结果：

```powershell
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git#<commit>
```

跟随默认分支：

```powershell
dsh plugin --profile web add git+https://github.com/tangzijie716/dsh-info-sources.git
```

本地开发：

```powershell
npm run dev:link
dsh plugin --profile web add link:D:\path\to\dsh-info-sources
```

`npm run dev:link` 会建立指向 Harness 所带 `@deepseek-ai/dsh-tools` 的开发链接。通过 Git 或 npm 正常安装时通常不需要执行它。

安装或升级后，请重启 DSH 或创建新会话。

## 快速开始

插件自带两个示例源：

- `aihot-daily`：JSON API 示例；
- `qbitai-feed`：RSS 示例。

```text
info_sources()
info_fetch(id="aihot-daily", limit=10)
info_fetch(id="qbitai-feed", limit=10)
info_collect(tag="ai", dedupe="title", sort="hot", limit=20)
```

### 使用用户覆盖层

用户覆盖层没有默认路径。每次需要使用时，必须显式传入 `sourcesPath`：

```text
info_sources(sourcesPath="config/my-sources.json")
info_fetch(id="my-source", sourcesPath="config/my-sources.json")
info_collect(tag="news", sourcesPath="config/my-sources.json")
```

不传 `sourcesPath` 时，插件只使用包内的 `config/sources.json`，不会自动读取环境变量、用户目录或以前调用过的覆盖文件。相对路径以当前 DSH 会话工作区为基准。

## 源清单

### 分层与合并

| 层 | 位置 | 行为 |
|---|---|---|
| 包内默认层 | `config/sources.json` | 随插件发布，提供默认值和示例源 |
| 用户覆盖层 | 调用参数 `sourcesPath` | 按 `id` 修改默认源或追加新源 |

同一 `id` 同时存在于两层时，用户层字段覆盖默认层字段。

### 配置示例

```json
{
  "version": 1,
  "defaults": {
    "method": "api-get",
    "timeoutMs": 15000,
    "limit": 20,
    "headers": {
      "Accept": "application/json, text/plain, */*"
    }
  },
  "sources": [
    {
      "id": "example-api",
      "label": "示例接口",
      "method": "api-get",
      "enabled": true,
      "tags": ["news", "example"],
      "url": "https://example.com/api/items",
      "query": {
        "language": "zh-CN"
      },
      "headers": {
        "Authorization": "Bearer $ENV:EXAMPLE_TOKEN"
      },
      "select": {
        "items": "data.items[]",
        "itemsFallback": ["items[]"],
        "title": "title",
        "hot": "score",
        "url": "url",
        "originalUrl": "originalUrl",
        "origin": "source.name",
        "publishedAt": "publishedAt",
        "summary": "summary",
        "label": "category"
      },
      "limit": 20,
      "timeoutMs": 15000
    },
    {
      "id": "example-feed",
      "label": "示例订阅",
      "method": "rss",
      "tags": ["news"],
      "url": "https://example.com/feed.xml",
      "limit": 20
    }
  ]
}
```

### 通用字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一源标识 |
| `label` | string | 显示名称，缺省时使用 `id` |
| `method` | string | `api-get` 或 `rss` |
| `enabled` | boolean | 是否参与默认多源采集，默认 `true` |
| `tags` | string[] | 筛选标签 |
| `url` | string | HTTP/HTTPS 地址，可包含 `{key}` 占位符 |
| `query` | object | 默认查询参数 |
| `headers` | object | 请求头，支持环境变量插值 |
| `limit` | number | 单源条数上限；`0` 表示不限制 |
| `timeoutMs` | number | 请求超时毫秒数 |
| `note` | string | 维护备注 |

### 环境变量插值

`url`、`query` 和 `headers` 中的字符串支持：

```json
{
  "Authorization": "Bearer $ENV:API_TOKEN",
  "X-Optional-Key": "$ENV:OPTIONAL_KEY?"
}
```

- `$ENV:NAME`：必填。缺失时源配置校验失败，插件不会发送请求；
- `$ENV:NAME?`：可选。缺失且字段值为空时删除对应字段并给出警告。

不要把密钥直接写入清单或提交到 Git。

### URL 参数

URL 可以包含路径占位符：

```json
{ "url": "https://example.com/dailies/{date}" }
```

调用时通过 `params` 提供：

```text
info_fetch(
  id="daily",
  sourcesPath="config/my-sources.json",
  params={"date":"2026-09-25"}
)
```

没有用于路径占位符的其他 `params` 会加入查询字符串，并覆盖 `query` 中的同名字段。

### `api-get` 字段映射

`api-get` 至少需要 `url` 和 `select.title`。`select` 支持：

- `items` 和 `itemsFallback`；
- `title`、`rank`、`hot`；
- `url`、`originalUrl`；
- `origin`、`publishedAt`、`summary`、`label`。

路径语法：

| 写法 | 含义 |
|---|---|
| `data.items` | 逐级读取属性 |
| `data.items[]` | 展开数组 |
| `data.groups[].items[]` | 连续展开嵌套数组 |
| `data.items[0]` | 读取指定下标 |

标题为空的条目会被忽略。不能转换为有限数值的 `hot` 会被省略。

### `rss` 字段映射

`rss` 只要求提供 `url`，并使用固定映射：

| 统一字段 | Feed 字段 |
|---|---|
| `title` | `title` |
| `url` | `link`；Atom 优先 `rel=alternate` |
| `summary` | `description`、`summary`、`content:encoded` 或 `content` |
| `origin` | 作者、来源分类或 Feed 标题 |
| `publishedAt` | `pubDate`、`published`、`updated` 或 `dc:date` |
| `label` | 分类 |

HTML 摘要会转换为单行纯文本，发布时间会尽可能转换为 ISO 8601。

### 注释与停用

以 `_` 或 `$` 开头的对象键会被忽略。需要保留但暂不解析的源可以放进顶层 `_disabled`：

```json
{
  "version": 1,
  "_disabled": [
    {
      "id": "future-source",
      "method": "rss",
      "url": "https://example.com/feed.xml"
    }
  ],
  "sources": []
}
```

要停用包内默认源，应在覆盖层 `sources` 中写入同一 `id` 和 `"enabled": false`。

## 工具参考

### `info_sources`

列出源、采集方式、启用状态、标签和校验问题。

| 参数 | 必填 | 说明 |
|---|---|---|
| `sourcesPath` | 否 | 本次使用的覆盖层 JSON |
| `tag` | 否 | 只显示包含该标签的源 |
| `includeDisabled` | 否 | 是否显示已停用源 |

### `info_fetch`

采集一个指定源。

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 源 ID |
| `sourcesPath` | 否 | 本次使用的覆盖层 JSON |
| `params` | 否 | 路径参数和查询参数 |
| `limit` | 否 | 本次调用的条数上限 |
| `path` | 否 | Markdown 输出目录或文件 |
| `save` | 否 | 是否写文件，默认 `true` |

### `info_collect`

并行采集多个源。单源失败不会阻止其他源返回结果。

| 参数 | 必填 | 说明 |
|---|---|---|
| `sourcesPath` | 否 | 本次使用的覆盖层 JSON |
| `ids` | 否 | 逗号分隔的源 ID，优先于 `tag` |
| `tag` | 否 | 按标签选择源 |
| `params` | 否 | 透传给各源的参数 |
| `dedupe` | 否 | `none` 或 `title` |
| `sort` | 否 | `none` 或 `hot` |
| `limit` | 否 | 汇总后的条数上限 |
| `path` | 否 | Markdown 输出目录或文件 |
| `save` | 否 | 是否写文件，默认 `true` |

没有指定 `ids` 和 `tag` 时，采集全部启用源。按标题去重时保留热度较高的条目，并在 `alsoFrom` 中记录其他来源。

### `info_reload`

强制重新读取清单并返回校验结果。

| 参数 | 必填 | 说明 |
|---|---|---|
| `sourcesPath` | 否 | 要重新读取的覆盖层 JSON |

文件修改时间或大小变化后，下一次调用通常会自动重载。环境变量变化后可使用该工具强制刷新。

### `info_source_save`

创建、更新或删除覆盖层条目。

| 参数 | 必填 | 说明 |
|---|---|---|
| `sourcesPath` | 是 | 要修改的覆盖层 JSON |
| `id` | 是 | 源 ID |
| `patch` | 否 | 要写入的字段 |
| `remove` | 否 | 删除覆盖条目，恢复包内定义 |

更新示例：

```text
info_source_save(
  sourcesPath="config/my-sources.json",
  id="example-feed",
  patch={"enabled":false}
)
```

删除覆盖条目：

```text
info_source_save(
  sourcesPath="config/my-sources.json",
  id="example-feed",
  remove=true
)
```

如果文件不存在，插件会创建文件及父目录。

## 采集结果

统一条目结构：

```json
{
  "sourceId": "example-api",
  "title": "示例标题",
  "rank": 1,
  "hot": 12345,
  "url": "https://example.com/item/1",
  "originalUrl": "https://origin.example.com/item/1",
  "origin": "示例来源",
  "publishedAt": "2026-09-26T04:54:05.000Z",
  "summary": "内容摘要",
  "label": "AI",
  "alsoFrom": ["another-source"]
}
```

`sourceId`、`title` 和 `rank` 为必填字段，其余字段均为可选字段。

### Markdown 输出

`info_fetch` 和 `info_collect` 默认写入 Markdown。输出位置优先级：

1. 调用参数 `path`；
2. 环境变量 `DSH_INFO_OUTPUT_DIR`；
3. DSH 会话工作区；
4. `process.cwd()`。

自动文件名为 `info_collection_<YYYYMMDDHHmmss>.md`，时间戳使用北京时间。自动命名不会覆盖现有文件，冲突时增加 `_2`、`_3` 等后缀；显式 `.md` 路径会覆盖目标文件。

```text
info_fetch(id="aihot-daily", path="collections")
info_fetch(id="aihot-daily", path="collections/daily.md")
info_fetch(id="aihot-daily", save=false)
```

## 错误处理

- HTTP、超时、解析和适配器错误转换为 `ok=false` 结果；
- 多源采集分别报告每个源的状态、URL 和 HTTP 状态码；
- 配置校验失败的源不会发送网络请求；
- 写文件失败通过 `fileError` 返回，不会丢弃采集数据；
- 无效 JSON、缺失的显式覆盖文件和不支持的清单版本属于清单加载错误。

## 开发与测试

### 稳定测试

```powershell
npm test
```

稳定测试不访问公网，覆盖清单合并、配置校验、API 映射、Feed 解析、多源去重和 Markdown 输出。

### 公网冒烟测试

```powershell
npm run test:live
```

该命令在稳定测试后访问包内示例源。网络不可用时相关检查显示警告，不会导致失败。

### Harness 解析测试

```powershell
npm run test:resolve
node test/bundle-resolution.mjs "C:\Users\<you>\.dsh\profiles\web"
```

### Feed 体检

```powershell
node test/check-feeds.mjs https://example.com/feed.xml
```

### 导出源快照

```powershell
node test/dump-source.mjs qbitai-feed "D:\output\qbitai.md"
```

### 发布前检查

```powershell
npm test
npm run test:live
npm run test:resolve
npm pack --dry-run
```

## 扩展采集方式

新增采集方式：

1. 在 `lib/methods/` 下创建适配器；
2. 在 `lib/methods/index.js` 中注册；
3. 增加配置校验、成功路径和失败路径测试；
4. 更新本文档。

适配器接口：

```js
export const adapter = {
  id: "example-method",
  label: "示例采集方式",
  summary: "采集方式说明",
  requiredKeys: ["url"],

  async run(source, { signal, params, defaults }) {
    return {
      ok: true,
      status: 200,
      url: source.url,
      items: [],
      rawCount: 0,
      matchedPath: "example"
    };
  }
};
```

可以复用以下公共模块：

- `lib/http.js`：HTTP 请求、超时、取消、解码和 URL 组装；
- `lib/source-util.js`：条数、超时和请求头合并；
- `lib/select.js`：字段路径读取；
- `lib/feed.js`：XML、RSS、Atom 和 RDF 解析。

## 项目结构

```text
dsh-info-sources/
├── config/
│   └── sources.json          # 包内默认源
├── lib/
│   ├── methods/
│   │   ├── api-get.js        # JSON API 适配器
│   │   ├── rss.js            # RSS/Atom/RDF 适配器
│   │   └── index.js          # 适配器注册表
│   ├── feed.js               # Feed 解析
│   ├── http.js               # HTTP 公共层
│   ├── index.js              # DSH 工具入口
│   ├── output.js             # Markdown 输出
│   ├── registry.js           # 清单加载、合并和校验
│   ├── select.js             # 字段路径解析
│   └── source-util.js        # 通用源参数
├── scripts/
│   └── link-dsh-tools.mjs    # 本地开发依赖链接
├── test/                     # 测试与辅助工具
├── cordis.patch.yml          # DSH bundle 配置
└── package.json
```

## 许可证

本项目采用 [MIT License](LICENSE)。
