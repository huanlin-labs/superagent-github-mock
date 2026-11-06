# superagent-github-mock

[![test](https://github.com/huanlin-labs/superagent-github-mock/actions/workflows/test.yml/badge.svg)](https://github.com/huanlin-labs/superagent-github-mock/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)（DeepSeek Harness 的「主动型 agent」原型）的 GitHub Source
做一套**离线可跑的 GitHub REST 仿真**：一套本地 HTTP mock、六个可重放的 fixture 场景、以及四组集成测试。

关键点不是「造了个假 GitHub」，而是：**测试里跑的是原型自己的 `pollRound()`，一行没改。**

---

## 1. 为什么需要它

读 `src/sources/github.ts` 会发现一件事：Source **不直接发 HTTP**。

```
pollRound(ctx)
  → ctx.commands.api('notifications?all=true…')      // src/sources/github.ts:305
    → Commands.api()                                  // src/infra/commands.ts:82
      → run(deployment.github.cli, ['api', 'repos/<owner>/<repo>/notifications…'])
        → execFile('gh', …)                           // src/infra/commands.ts:70
```

也就是说：想要在**不联网、不要 token、不装 gh 登录态**的前提下测试这段逻辑，光起一个 `127.0.0.1:xxxx`
的服务器没用——中间还隔着 `gh` 这个子进程。所以本项目做了两件事：

1. **`src/shim/gh.ts`** —— 一个只实现 Source 用到的那部分 `gh api`（`--include`、`--paginate --slurp`、
   `-f key=value`、`-X/--method`、`-H`，以及 gh 出错时 `gh: … (HTTP 404)` + 非零退出的写法）的转发器。
2. **`src/harness/transport.ts`** —— 继承原型真实的 `Commands` 类，**只覆盖 `run()`** 这一个方法，
   让它去问本地 mock 而不是 spawn 子进程。`path()` 的「只允许本仓库」限制、`pages()` 的
   `--paginate --slurp` 解析、`commandError()` 把退出码翻译成 `CliError.code`，全都还是原样的。

结果：**410（已删除）与 304（ETag 未变）之所以能被区分，是因为走的是原型自己的错误翻译路径**，不是我在测试里假装。

接上去之后，一次轮询长这样（`npm run dump` 会原样打出这一路）：

```
pollRound(ctx)
  └─ ctx.commands.api('notifications?all=true…')          ← 原型代码，未改
      └─ Commands.path()  只允许本仓库                     ← 原型代码，未改
      └─ Commands.run()   ← 本项目唯一动过的地方（src/harness/transport.ts）
          └─ ghApi(['api','repos/acme/widgets/notifications…'])   ← src/shim/gh.ts
              └─ fetch → 127.0.0.1:<随机端口>            ← src/mock/server.ts
                  └─ handle(world, repository, request)        ← src/mock/routes.ts
                      └─ fixtures/*.json 描述的"世界"
```

所以改的时候只有三个入口：**fixture**（描述世界）、**routes**（多一条端点）、**transport**（换掉的是 `run()` 还是别的）。

---

## 2. 目录

```
作品-mock-github/
├─ fixtures/                  六个场景，一个场景一个 JSON「世界」
│  ├─ 01-issue-mention.json
│  ├─ 02-inline-review.json
│  ├─ 03-review-approval.json
│  ├─ 04-ci-failure-recovery.json
│  ├─ 05-issue-gone-410.json
│  └─ 06-pagination-etag.json
├─ src/
│  ├─ mock/
│  │  ├─ world.ts             fixture → 世界状态（时间偏移、rounds 补丁、id 合成）
│  │  ├─ routes.ts            GitHub REST 路由表
│  │  └─ server.ts            node:http 服务器 + 请求记录 + `/__mock/*` 控制面
│  ├─ shim/gh.ts              gh api 转发器（也能当真正的 gh 用）
│  └─ harness/
│     ├─ hooks.ts             让原型能 import 到本机已有的 zod / schemastery（不装、不联网）
│     ├─ transport.ts         继承真实 Commands，只替换 run()
│     └─ context.ts           拼出 pollRound() 需要的 SourceContext，并跑一轮
├─ test/
│  ├─ contract.test.ts        mock 自身的 HTTP 契约（不碰原型）
│  ├─ pollRound.test.ts       真实 pollRound() 跑六个场景
│  ├─ outbound.test.ts       真实 sendGithub()：幂等标记、review 线程回复、410/404
│  └─ binding.test.ts        真实 claimPull()/observePull()：PR 与工单的绑定与终结
├─ tools/
│  ├─ serve.ts                起一个 fixture，供 curl / 手工走查
│  ├─ dump.ts                 逐轮打印 Trigger / health / 请求
│  ├─ list.ts                 列出 fixture
│  └─ bootstrap.ts            --import 入口（装解析钩子）
├─ LICENSE · NOTICE · CHANGELOG.md · SKILL.md
├─ prototype.path.example     本机原型指针的模板（真正的 prototype.path 不进仓库）
└─ .github/workflows/test.yml 契约组 + 真实源码组两段 CI
```

---

## 3. 跑起来

需要 **Node ≥ 24**（直接用 Node 自带的 TypeScript 类型擦除跑 `.ts`，不编译、不打包）。
先把它指向一个 dsh-superagent 的原型检出（要含 `src/sources/github.ts`）：

```powershell
cd 作品-mock-github
"E:/path/to/dsh-superagent-prototype" > prototype.path   # 或设 $env:SUPERAGENT_SRC
npm test            # 34 个用例：契约 / 真实 pollRound / 回帖 / PR 绑定
npm run list        # 六个场景是什么
npm run dump        # 逐轮打印每个场景产生的 Trigger 和全部请求
```

`prototype.path` 在 `.gitignore` 里（本机指针，不进仓库）；也可以把原型检出放在同级目录并命名为
`dsh-superagent-prototype`。缺少这两者时，harness 会直接报错并说明怎么指。

手工走查一个场景：

```powershell
npm run serve 01-issue-mention -- --port 8787
# 另开一个窗口
curl http://127.0.0.1:8787/repos/acme/widgets/issues/12
curl http://127.0.0.1:8787/__mock/requests
$env:GITHUB_MOCK_URL="http://127.0.0.1:8787"
node --experimental-transform-types src/shim/gh.ts api "repos/acme/widgets/notifications?all=true&per_page=50" --include
```

`04` 与 `06` 有多个轮次：`curl -X POST http://127.0.0.1:8787/__mock/round/1` 切到下一轮再看。

---

## 4. 六个场景

| fixture | 复现的现场 | 原型里必须成立的事 |
|---|---|---|
| `01-issue-mention` | 同事开了 Issue #12 并 @ 了 agent | 通知 + 仓库级 Issues 流**只能产出一个** Trigger；`addressed: 'mention'`；`actor` 是作者；重放同一轮不重复 |
| `02-inline-review` | 在 PR #40 的 hunk 上留行内 review 评论，再回自己一句 | 三个 Trigger（PR 描述 + 两条行内）；行内评论带 `path`/`line`，正文是 `文件:行` + diff 尾行 + 评论；回复带 `inReplyTo`；`githubThreadContext` 能把这条 review 线程读回来 |
| `03-review-approval` | 只点了 APPROVE、**正文为空** | 仍然产生 Trigger，正文是 `APPROVED review of commit <sha>`——worker 可能正等这个批准 |
| `04-ci-failure-recovery` | 默认分支 CI：绿 → 红 → 绿 | 第一轮只建基线、不发 Trigger；红与绿各一条，`revision` 递增使 id 不同；CI 的 `human: false` 且**没有** `channel`（无处可回） |
| `05-issue-gone-410` | 通知指向已被物理删除的 Issue #13 | 轮次**不失败**；health 里记 `deleted on GitHub: #13`；不进重试队列（410 是永久的） |
| `06-pagination-etag` | 账号 120 条通知（3 页），其中只有 2 条属于本仓库；下一轮无变化 | 跟完 `rel="next"` 三页；别仓库的通知被过滤掉；重复请求带 `If-None-Match` 收到 304，不再消耗配额 |

---

## 5. 端点 ↔ 源码对照

mock 只实现这些路径，其它一律 404（和真 GitHub 对未知路径的态度一致）。

| Mock 路径 | 谁在读 | 源码位置 |
|---|---|---|
| `GET /repos/{r}/notifications?all&per_page&since` | 通知流；读 `x-poll-interval`、`Link: rel="next"` | `github.ts:304`、`:310`、`:312` |
| `GET /repos/{r}/issues/{n}` | 通知指向的 Issue（PR 也走这里，带 `pull_request`） | `github.ts:348` |
| `GET /repos/{r}/pulls/{n}` | PR 主体 | `github-pull.ts:17` |
| `GET /repos/{r}/issues/{n}/comments?per_page&since` | 会话评论 | `github.ts:390` |
| `GET /repos/{r}/pulls/{n}/comments?per_page` | 行内 review 评论 | `github.ts:390`、`github-read.ts:86` |
| `GET /repos/{r}/pulls/{n}/reviews?per_page` | review 决定（含无正文的 APPROVED） | `github.ts:390` |
| `GET /repos/{r}/issues?state=all&sort=updated&since` | 仓库级新 Issue/PR 流（**带 ETag**） | `github.ts:174`、`:203` |
| `GET /repos/{r}/issues/comments?…` | 仓库级会话评论流（带 ETag） | `github.ts:175` |
| `GET /repos/{r}/pulls/comments?…` | 仓库级行内评论流（带 ETag） | `github.ts:176` |
| `GET /repos/{r}` | `default_branch` | `github.ts:253` |
| `GET /repos/{r}/commits/{branch}` | 默认分支指向的 sha | `github.ts:254` |
| `GET /repos/{r}/commits/{sha}/check-runs?per_page` | check runs（`--paginate --slurp`） | `github-read.ts:62` |
| `GET /repos/{r}/commits/{sha}/statuses?per_page` | commit statuses（取每个 context 的最新一条） | `github-read.ts:64` |
| `POST /repos/{r}/issues/{n}/comments` | 回帖 | `github-channel.ts:33`、`:39` |
| `GET /repos/{r}/pulls/comments/{id}` | 回复行内评论前先找线程根 | `github-channel.ts:29` |
| `POST /repos/{r}/pulls/{n}/comments/{root}/replies` | 回复行内线程 | `github-channel.ts:38` |
| `GET /repos/{r}/contents/{path}` | 读仓库文件/目录 | `github-read.ts:52` |

`HTTP 410`：`github.ts:158`（`deleted()`）→ 记为 dropped 而不是失败；`HTTP 304`：`github.ts:216` → 直接返回，本轮不读。

---

## 6. 测试分四组

- **`contract.test.ts`（13 个）** —— 只看 mock 和 shim：分页的 `Link`、ETag/304、410、`--include` 的表头格式、
  `--paginate --slurp` 的「每页一个数组」、404/410/304 变成 gh 的 stderr 与非零退出码，
  以及把 shim 当 gh 放在 PATH 上时裸调用要打印用法并退 2（而不是抛栈）。
  它保证「场景测试失败」时先能判断是 mock 变了还是原型变了。**这组不需要原型**，CI 单独跑。
- **`pollRound.test.ts`（11 个）** —— 导入原型真实的 `sources/github.ts` 的 `pollRound()`，
  喂给它一个实现了 `host.ts` 接口的 `SourceContext`，断言真正产出的 Trigger。还额外直接调用了
  `github-read.ts` 的 `githubThreadContext.read()` 读回 review 线程。
- **`outbound.test.ts`（3 个）** —— 真实 `sendGithub()`：Issue 回帖的幂等标记、行内 review 线程回复
  （落到 `pulls/<n>/comments/<root>/replies`）、410 回 `gone` 而 404 必须抛出重试。
- **`binding.test.ts`（7 个）** —— 真实 `claimPull()` / `observePull()`：PR 合并/关闭上报给工单、
  agent 在 `agent/<名字>` 分支上开的 PR 自动绑定、别人的 PR 不动、不属于本工单的 PR 被拒。

```powershell
npm test
# ℹ tests 34   ℹ suites 8   ℹ pass 34   ℹ fail 0
```

---

## 7. 限制与取舍（如实说明）

- **没有 `tsc`**：本机没有 TypeScript 编译器且要求不联网，所以 `.ts` 只做类型标注、由 Node 擦除执行，
  **没有跑过 `tsc --noEmit`**。类型错误不会被发现——这是取舍，不是遗漏。
- **两个依赖是「借来的」**：原型 `import 'zod'` 与 `import '@deepseek-ai/schemastery'`，Node 会按
  **import 方所在目录**去找包，而原型目录里没有 `node_modules`。`src/harness/hooks.ts` 用
  `module.registerHooks` 把这两个裸模块名映射到本机已有的副本（版本与原型 `package.json` 一致：
  zod 4.4.3、schemastery 3.18.5），**原型一行没改**。因此项目里带着约 4.6 MB 的 `node_modules/`，
  且 `.gitignore` 忽略它——换台机器时要么 `npm i zod @deepseek-ai/schemastery`，要么把 DSH profile 的
  那两份指过去（`DSH_PROFILE_NODE_MODULES`）。
- **`--experimental-transform-types` 是必须的**：原型的 `Commands` 用了构造函数参数属性，
  Node 的 strip-only 模式不支持，只能用 transform 模式。
- **fixture 的时间写成 `"+30s"` 这种相对偏移**。原因在原型里：`readStream()` 的 `fresh()` 只接受
  「比本轮开始还新」的事件（"从打开开关那一刻开始读"的语义），写死日期会让场景永远读不到东西。
- **mock 不模拟速率限制与二次校验**：没有 `x-ratelimit-*`、没有 422/5xx 的随机注入，也没有 Secondary
  Rate Limit。这些不影响被覆盖的分支。

---

## 8. 这套东西想证明什么

1. **先读代码，再动手**：真正决定方案的不是「GitHub API 长什么样」，而是查清了 `Commands.api()` →
   `execFile('gh')` 这条链路，以及 `key()`、`cursorAt()`、`fresh()`、`deleted()` 这些具体语义。
2. **替身要替在最窄的地方**：能替换掉一个 `run()` 就不该重写 `Commands`；能给接口塞一个对象就不该
   mock 掉整个 Engine。这样测试失败才有意义。
3. **失败路径要和成功路径一样被证明**：410、304、跨仓库通知、无正文的 review、被删除的线程——
   这些才是 Source 真正容易写错的地方。
