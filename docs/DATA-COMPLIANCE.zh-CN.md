# 数据与许可合规

[English](DATA-COMPLIANCE.md) · **中文**

这篇记录 gladlog 从外部拿了什么、依据是什么条款、以及哪些做法被我们明确排除。
写下来是为了不用每次从零调研 —— 也因为本仓在这件事上已经错过一次(早先的注记
把 wowarenalogs feed 写成「自有产品」,它不是)。

除另有注明外,以下结论均于 **2026-08-01** 核实。承重的每一条都带日期,因为条款会变,
而代码不会察觉。

## 1. 上游数据源

`wowarenalogs.com` 是**第三方志愿者项目**(法律实体 Alotof Technology LLC,
Kirkland WA;联络 `privacy@wowarenalogs.com`;维护者渠道为其
[Discord](https://discord.gg/NFTPK9tmJK))。我们与其无隶属关系。它的 Firestore
读取与 Cloud Storage 出口流量记在他们账上,不是我们的。

约束该站使用的文件,全部在此:

| 文件                                                    | 说什么                                                                                                                                                 | 对我们的影响                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| [privacy.html](https://wowarenalogs.com/privacy.html)   | 明文写「Your contributions to the Service are intended for public consumption and are therefore viewable by the public, **including your game logs**」 | 上传者已同意其 log 公开。这是我们最强的立足点。 |
| `robots.txt`                                            | `User-agent: * / Disallow:` —— 全放行,无 `Crawl-delay`                                                                                                 | 自动化访问不违反 robots。                       |
| [LICENSE](https://github.com/wowarenalogs/wowarenalogs) | `CC BY-NC-ND 4.0`,措辞为覆盖「WoW Arena Logs and **all other code** in this repository」                                                               | 只管**代码**,不管上传的日志数据。               |

**不存在 Terms of Service。** `tos.html` 返回 404,仓库里也没有任何 terms 文件,
只有 `packages/web/public/privacy.html`。所以既没有禁止自动化访问的合同条款,
也没有明示许可。我们的克制是一种选择,不是合规义务。

## 2. 我们用的接口,以及拒绝使用的那个

**使用 —— 公开 GraphQL feed。** `POST https://wowarenalogs.com/api/graphql`,
匿名,`latestMatches(...)` 带服务端 `bracket` / `minRating` / `compQueryString`
过滤,分页 cap 50;随后对返回的 `logObjectUrl` 做一次普通 GET。这就是他们自己
的前端在用的接口。

**拒绝 —— bucket 列举。** GCS bucket `wowarenalogs-log-files-prod` 把
`storage.objects.list` 授予了 `allUsers`,于是
`GET https://storage.googleapis.com/wowarenalogs-log-files-prod?max-keys=1`
对任何人返回全量对象清单,且不受 feed 那个 ~7 天窗口的限制。他们的前端从不需要
列举 bucket,所以这几乎肯定是配置疏漏,而非对外提供的接口。

**我们不用它。** 公开可访问 ≠ 意图公开,在一个项目实际发布的界面之外取数,不是
我们想依赖的东西。2026-08-01 决定:不使用,也不告知。记在这里是为了它不会被
重新「发现」后悄悄用上。

## 3. 采集自律(`packages/corpus-tools`)

- **可识别的 User-Agent**,覆盖每一个出站请求(feed 与 GCS 一视同仁),挂在
  `src/feedClient.ts` 的唯一咽喉 `fetchWithRetry` 上。没有它,我们在对方日志里
  跟任意爬虫无法区分,而对方唯一可用的处置就是整段封 IP,连带误伤别人。
- **按代价分开计额。** 翻页打的是 Firestore 读;单场下载打的是 GCS 出口带宽,
  一场 Solo Shuffle 可达 ~30MB。页间隔 500ms,下载间隔 2s(`DOWNLOAD_SLEEP_MS`),
  串行,绝不并发。下载计数器计的是**尝试**而非成功 —— 被丢弃的不完整下载同样
  已经消耗了对方带宽。
- **有界翻页**(`MAX_PAGES`,默认 40)+ manifest 断点续传,重跑绝不重下。
- **只对 429/5xx/网络错误重试**,指数退避封顶 15s。

feed 只留约 7 天(GCS 对象约 30 天)。所以攒语料只能靠长期低频轮询,不是一次猛拉。
如果哪天它变成常驻定时任务,回来重看本节。

## 4. 日志里的个人数据

战斗日志含角色名、服务器,以及 `Player-realmID-hexID` 形式的 GUID。GUID 跨角色
稳定,因此在 GDPR 下属于假名化个人数据,不是匿名数据。上传者同意了公开(见 §1);
同场其他玩家并未同意 —— 除游戏本身向参与者广播的那部分之外。

当前策略(2026-08-01 决定):**原样存储,不做假名化。** 理由:parser 需要 GUID
关联单位,且数据本就公开。这是有意选择,不是疏漏。

我们刻意**不**采集的:GCS 对象 meta header `x-goog-meta-ownerid`,它携带上传者的
账号 id。`downloadWithMeta` 只取 `wow-version`、`client-timezone`、`client-year`、
`starttime-utc` —— 重建绝对时间所必需的字段,因为 log 时间戳无年份且为上传者本地时区。

下载物与 `manifest.json` 默认落在仓外(`$GLADLOG_EVAL_HOME`),严禁提交进公开仓库。

## 5. 代码许可 —— 真正要紧的那部分

gladlog 是 MIT。wowarenalogs 的代码是 **CC BY-NC-ND 4.0**,既禁商用**又**禁衍生。
两者不相容:MIT 再分发不可能叠在 ND 许可之上,而且光加署名并不能解决。

`packages/parser-compat/src/enums.ts` 在 2026-08-01 之前是逐行照抄他们的
`packages/parser/src/types.ts` —— 连他们的代码风格、以及把暴雪的 "Brewmaster"
误写成 `Monk_BrewMaster` 都一并抄了过来。

**修法:** `CombatUnitSpec` 与 `CombatUnitClass` 现在由
`packages/analysis/scripts/datagen/genCombatUnitEnums.ts` 从暴雪自己的 DB2 表
(`ChrSpecialization`、`ChrClasses`)生成,命名规则由本仓自定并写明。其余枚举各自
锚定到一项暴雪事实:`LogEvent` 的值就是日志格式里逐字出现的事件记号,
`CombatUnitPowerType` 对应客户端 API 的 `Enum.PowerType`,旗标掩码是公开的
`COMBATLOG_OBJECT_*` 常量。

关于这次改动做到了什么、没做到什么,得说实话。与他们文件的逐行重合**并没有下降** ——
归一化引号后是 108 → 115 行,因为 51 行 `LogEvent` 和 39 行 `专精名 = "暴雪id"`
本就是任何正确实现都必须表达的同一批事实。立论是独立推导与 merger,不是文本差异。
真正改掉的是**非事实**的那部分:

- `CombatUnitClass`:13/13 个取值全部替换。他们那套编号是自造的(`Hunter = 2`),
  我们还专门维护一张 `BLIZZARD_CLASS_TO_LEGACY` 翻译表去迁就它。现在取值**就是**
  暴雪的 `ChrClasses.ID`(`Hunter = 3`),翻译表已删除。
- 成员顺序:原本 41/41 个位置与他们相同,现在 1/41。
- 出处:取值随每个游戏版本从 DB2 重新生成,不再有任何从他们仓库手工誊抄的路径。

`packages/parser-compat/data/legacy-enum-manifest.json` 保留,且**不是**问题:
它是在旧包上运行时 dump 出来的(M4 计划明文禁止读他们源码),记录的是观察到的
互操作事实。为互操作而复制接口事实属于受青睐的情形,不是被否定的情形。差分预言机
不比 `class` 字段(其 `NormUnit` 只取 `spec`/`reaction`/`type`),所以这次改号
碰不到那道门。

## 6. 暴雪的美术素材,以及他们的 CDN

战斗日志是客户端生成的文本,玩家自行开启并上传;Warcraft Logs 以同一模式运营了
十几年。风险实际在**美术素材**,不在日志数据。

2026-08-01 之前,出货 App 在运行时热链 `images.wowarenalogs.com` 取专精图标与
竞技场小地图 —— 每个安装都在花志愿者项目的带宽,拿的还是他们二次托管的暴雪美术。

- **专精图标:已修。** `specIconName()` 现在把暴雪的
  `ChrSpecialization.SpellIconFileID` 解析成图标基名(`genSpecIcons.ts`,40/40
  全部解析成功),渲染走既有的主进程 `iconCache` —— 与技能图标同一条路,带永久
  磁盘缓存与会话级取图预算。
- **竞技场小地图:已修,方式是推翻一个旧决定。** 15 张底图现在随包发布
  (`src/renderer/src/report/data/minimaps/`,由 `import.meta.glob` 解析 ——
  缺文件在构建期就失败,而不是运行时 404)。`arenaMaps.ts` 此前以「版权 + 体积」
  为由不让它们入仓;2026-08-01 重新权衡后推翻:体积实测合计仅 164KB,而版权上
  这些美术无论如何都属于暴雪 —— 入仓与热链在这点上并无区别,热链还额外花掉
  志愿者项目的带宽。这是有意的推翻,记在这里以免日后看起来像疏漏。

现在 App **完全不再于运行时请求 `images.wowarenalogs.com`**。视觉回归会守住这条:
`qa/support/stubExternal.ts` 不再为任何外部主机放行,新增 CDN 依赖会指名道姓地
把用例打红,而不是留一条飘忽的基线。取图发生在主进程,Playwright 的 `page.route`
拦不到,所以 `iconCache` 增加了由 `GLADLOG_E2E=1` 置位的 `offline` 开关。

## 待决事项

- **定时轮询**(BACKLOG #19)。2026-08-01 的决定是不联系维护者、保持低频推进。
  若采集频率显著上升,回来重看 §1 与 §3。
- **内置的暴雪美术。** 专精图标仍在运行时取自 Wowhead 的 CDN
  (`wow.zamimg.com`),小地图现在随安装包发布。两者都未获授权,都建立在暴雪对
  同人工具的普遍容忍之上。若暴雪的同人内容政策哪天被较真,暴露点就在这里。
