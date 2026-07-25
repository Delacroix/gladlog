# Changelog

每个 release 一节,列出全部改动与对应 commit(`git log v<prev>..v<new>`
口径,release/纯文档 commit 归入「其他」)。发版流程见
`.claude/skills/release`。

## v0.1.9(2026-07-25)

来源:外部评审《调整方案.md》全量落地(经 agy 辩论采纳,五条修正)+
category 枚举化独立任务。

### 事件表

- `4d4f9ab` 死亡清场折叠(连续同目标 −失去 ≥5 条 → 一行聚合,±1.5s 有死亡标
  「死亡清场」chip)、周期 tick 聚合(同源同技能连续 ≥3 → ×N 求和);吸顶表头
  与表格自持滚动;「再显示 300 条」按钮换近底滚动加载 + 自动补页;kind 过滤
  换胶囊(色点 + 计数);伤害/治疗数额 p95 微条分色;死亡行高亮 +「▶ 死亡回顾」
  直达。

### AI 分析

- `f22776e` 关键时刻轴两级化:死亡/爆发带保持完整药丸,防御/驱散/控制降为
  小字行;同类同侧连发(≤5s)折叠为「{类} ×N」;条目 >40 收「+N 次要时刻」
  阀门;图标统一文本字形(禁 emoji);severity 中文映射(高/中/低);证据
  chip 补事件名短标签。
- `877c77d` category 从模型自由 string 收敛为八 slug 英文枚举(prompt 约束 +
  审计层归一 + 聚合按归一键),渲染侧中文词表(生存/冷却使用/站位/目标选择/
  控制/打断/驱散/进攻)。真模型 smoke:枚举合规率 9% → 100%(6 场 sonnet
  中文回复)。错题本跨场聚合从此稳定。
- `168af31`(P3-1 部分)cohort 卡:单维不再渲染「最强/最弱」;分位话术统一
  「第 N 百分位 · 高于/低于本分档中位」;spec 中文(42 专精词表)、
  「样本 N 场」。

### 战报

- `c5e3f33` 打断/驱散/爆发账本/失误清单四卡空数据保留卡壳 + 一行空态文案
  (0 失误显示「干净局」);光环 uptime 按单位分组(组头职业色 + 缩进 +
  超 top-6 展开)+ 0:00/mid/end 刻度 + 类别图例;失误清单严重度过滤 chips
  (>12 行默认藏轻微);死亡回顾进战报自动展开最近一次友方死亡(✕ 关闭后
  本场不再弹);HP 曲线图例行(点击 = 隐藏曲线)、⚠ 标记 <8px 聚簇为 ⚠N、
  死亡标签与 ⚠ 相邻时左锚避让;Shuffle 报表头 W/L 胶囊即回合切换
  (R{i}·W/L,键盘可用),删独立 Round tabs 行。
- `168af31`(P2-2/P3-2 部分)榜单数值分级缩写(1.54M/568k,title 保留精确
  全值,treemap 明细同规格);窗口列表行尾时长 chip + 击杀结果 chip。

### 回放

- `00a2efd` 地图名字标签按需显示(hover / HP<50% / 爆发中才渲染)+ 黑描边
  底板 + 相邻 <70px 自动上抬避让;GCD 泳道「标准/紧凑」档(紧凑 88px 列宽,
  chip 只留图标,localStorage 记忆)+ 泳道下方击杀窗口金色跳转 chips(点击
  两栏共享时钟同跳);底部双行快捷键/图例说明收进控件条右端 ? 圆钮。

### 全局

- `fddbf13` 技能名全站语言统一:渲染层 5 处 `getEnglishSpellName` 调用换
  `displaySpellName` 单源(日志原名直通,空才落词典)。CN 对局英文词典名
  1299 处 → 9 处(残留均为日志原文)。

### 其他

- `51e875f` `4f32916` CI 修复(空态断言随新行为反转、chip 兜底、漏交文件)。
- `5e5a2ca` + `51e875f` 内含:九张视觉基线中七张重录(逐张人审)。
- `d888619` session 沉淀文档(prod-triage skill 等)。
- `049d6c4` release bump。

---

以下为**追溯补记**(2026-07-25 据 git 历史生成:每版 = `git log v<prev>..v<new> --oneline --no-merges`;超过 40 个 commit 的版本只列 feat/fix/perf,省略 chore/docs/test/refactor 等,全量见 git log)。

## v0.1.8(2026-07-25)

- `f5e63fd` release: v0.1.8 —— GCD 泳道折叠(同刻一行 + off-GCD 小图标,用户设计)
- `b302351` chore(qa): 视觉基线 —— 泳道折叠版重生成(已人审:同刻折叠一行、off-GCD 小图标、大招描金)
- `0751bf4` feat(desktop,analysis): GCD 泳道折叠 —— 同刻多技能一行化,off-GCD 主动技折为小图标(用户设计)

## v0.1.7(2026-07-25)

- `70585a9` release: v0.1.7 —— GCD 泳道换轴:时刻精确对齐(漂移均 15.8s→0),重叠横向阶梯
- `a89c46f` chore(qa): 视觉基线 —— 泳道换轴后重生成(已人审:时刻精确对齐,阶梯可读)
- `7d75573` feat(desktop): GCD 泳道换轴 —— 纵向钉真实时刻,重叠横向阶梯,漂移 92%>0.5s(均 15.8s)→ 0

## v0.1.6(2026-07-25)

- `6783147` release: v0.1.6 —— 光环虚线推断修正(幻影整场虚线清零)+ CC 时长数据潜伏 bug 修复
- `39bad78` chore(qa): 视觉基线 —— 光环虚线修正后 uptime 卡重生成(battle/window 两张,已人审:幻影整场虚线消失)
- `1af0d55` fix(analysis,desktop): 光环虚线推断修正 —— 双来源分键/DOSE 开段/官方时长封顶 + 潜伏的 overrides 空壳压条 bug

## v0.1.5(2026-07-25)

- `747ff60` release: v0.1.5 —— 萌芽误杀修正 / 图标缺失 89%→0.05% / DR 表官方化 / dispel fallback 双证据清除
- `183fc23` chore(qa): 视觉基线 —— 萌芽类真按压回归 + 图标名全量解析,report-replay 重生成(已人审)
- `92a91cd` fix(analysis,eval): 图标宇宙定版 —— 三源并集 1.5MB,覆盖率不损(0.05% 缺失),首渲预算内
- `028e625` feat(analysis,desktop): 三项收口 —— 萌芽误杀修正 / 图标全量化 89%→0.05% 缺失 / DR 表官方化(抓出 2 错判+1 隐性失效)

## v0.1.4(2026-07-25)

- `210a884` release: v0.1.4 —— 泳道终局门(吞噬/幻灵清零,折叠 5.3%,误杀 0)+ 官方 PvP 替换表 17 对
- `2267f7e` fix(desktop): 泳道门终局 —— 默认保留 + 分层否决,误杀清零、折叠 5.3%、吞噬/幻灵清零
- `cef7d32` feat(analysis,desktop): 自制数据换正式数据 —— PvP 天赋替换表(官方 17 对)+ 玩家按键表(泳道垃圾清零,折叠 44.5%→1.9%)

## v0.1.3(2026-07-25)

- `d883607` release: v0.1.3 —— doc 瘦身(-39%)+ 读取自愈迁移,修内存 2GB+ 攀升(顺手清掉误入库的临时脚本)
- `0f7196b` fix(parser,desktop): doc 瘦身 —— 单场 442MB/内存 2GB+ 事故,params 稀疏化 -39% + 读取自愈迁移

## v0.1.2(2026-07-25)

- `beb926a` release: v0.1.2 —— GCD 泳道滤噪(折叠 44.5%→10.5%)/ 读条排队容差 / 灼热凝视替换 / 非法占位符堵漏
- `927c4eb` chore(qa): 视觉基线 —— GCD 泳道滤噪后 report-replay 重生成(其余 8 张字节级不变,已人审)
- `43d22c6` fix(desktop,analysis): GCD 泳道垃圾施法折叠真技能 / 读条排队误掐 / PvP 天赋替换未建模
- `070c923` fix(analysis,desktop): agy flash 复核采纳 3 条 —— 非法占位符堵漏 / 重试静默 / facts 键命名空间契约

## v0.1.1(2026-07-25)

- `1cbbe1c` release: v0.1.1 —— 修「只有2条/格式异常」:序号占位符 + max_tokens 扩容 + bad-json 重试;附生产验证驱动
- `9ca89e8` fix(analysis,desktop): 0.1.0 生产反馈两症状 —— 「只有2条」与「格式异常」

## v0.1.0(2026-07-24)

- `4b744c1` feat(analysis,eval): 可解性置信门 —— missed-cleanse/purge 主张语料实证率 92%/79% → 100%/100%
- `f5a7f54` feat(analysis,desktop,eval): 证据菜单覆盖面扩充 —— 治疗视角 3.4→8.6 条/场,三时段覆盖 0/17→11/17
- `2fff58a` fix(qa,desktop): 链路4 断言口径修正 —— 离屏窗初始高压到 500,>600 才真正证明整页捕获
- `e05c1e5` chore(qa): 视觉基线 —— 战报工具条新增「导出图片」按钮,3 张 report-* 重生成
- `a9569dc` feat(parser,desktop,eval,docs): 可验证性路线图剩余四项收口 —— B2 raw 行号深链 / trust chain e2e / B3 覆盖接入 / C3 图片导出
- `af5cd37` chore(qa): 视觉基线 —— df2789c UI 变更(时间窗条/失误卡/uptime/事件视图)4 张 report-* 重生成
- `473101d` feat(eval,docs): B1/SP-A.1 因果判官校准结案 —— causal-hardening 检出 50%→80%,verifiability 路线图五项收口
- `df2789c` feat(parser,eval,desktop): 可验证性路线 A2/A3/C3/B2 落地
- `95b8581` docs(backlog): #8 确定性失误检测 v1 结案(release/0.1)
- `6af9185` chore(qa): 视觉基线 —— 第四阶段④②③(失误清单/⚠标记/光环 uptime/事件视图)
- `c59ba8c` feat(desktop,analysis): 光环 uptime + events 视图 + 确定性失误引擎 —— 第四阶段④②③落地
- `ccd9e72` chore(qa): 视觉基线 —— 时间窗工具条(battle/synth)+ 新增 report-window 选中态
- `04cdabe` fix(desktop): TimeRangeBar 回显容差抬到 1s —— band 真值 36.734 vs 取整标签 36
- `b9a3142` fix(desktop): TimeRangeBar phase 下拉回显用容差匹配 —— band 起止带小数秒
- `5c29c2b` test(desktop): report-window 视觉场景 —— 时间窗选中态入基线
- `e1be96d` feat(desktop): 时间窗联动 —— 第四阶段① WCL timeframe/phase 交互落地
- `14e414a` chore(release/0.1): 开大版本分支 —— 版本升 0.1.0 + 第四阶段设计定稿

## v0.0.18(2026-07-23)

- `2cd5595` release: v0.0.18 —— 打断/驱散仪表盘、列表 comp/日期筛选、敌方饰品推断 + 漏驱散 7 条离散 CD
- `dc06585` chore(qa): report-synth 基线更新 —— 面板满状态入基线(其余六张字节级不变)
- `78b9ac5` test(desktop): synth fixture 注入打断命中 + 漏 purge —— 视觉基线覆盖面板满状态
- `bb85992` docs(backlog): #2/#3/#9 结案 + zh/EN 切换核实为已完成
- `0ba6cca` chore(qa): 重生成视觉基线 —— 打断/驱散面板 + 筛选条 comp/日期两维
- `793e127` fix(desktop): 筛选条日期组包成不可拆单元 —— 窄侧栏折行时分隔符不再孤行
- `fc2c73b` feat(desktop): 列表筛选补 comp(同队多专精)与日期范围 —— backlog #9 收尾
- `f145aaf` feat(desktop): 打断/驱散仪表盘 —— backlog #2/#3 打包落地
- `3746c55` feat(eval): §7ter 启用 + templateDuplicateRatio 单独定档 —— 两个 eval 决定落地
- `6949e20` feat(analysis): 敌方饰品未观察到使用推成可用 + 漏驱散补 7 条离散主动 CD —— 两个产品决定落地
- `08dcf63` docs(backlog): Layer B 三修复复评结案 —— 前后数字齐 + noise 重锚定副作用登记待拍板
- `65c791d` feat(eval): sufficiency 覆盖门裁决落地 + blindPool matchId 占位约定 —— 14.2/14.4 结案

## v0.0.17(2026-07-22)

- `580b4e4` release: v0.0.17 —— DMG SPIKE 起止时间戳、武僧打断专精分流、eval rubric 口径修复
- `d243f4b` fix(analysis,eval): Layer B 300 场评测挖出的三处真 bug —— DMG SPIKE 起止歧义/武僧打断误判/noise 口径缺口
- `6a5a905` docs(backlog): 14.2/14.5 结案 —— 修掉过期状态与一处被推翻的旧结论
- `cd21b15` docs(handoff): §1 收尾 —— 6/7,Layer B 可以开跑
- `22af6fd` docs(report): 上限修完后全 80 件重评 —— 4/7 → 5/7 → 6/7,余量变厚
- `d39b34b` fix(eval): 审计集 12 条上限吃掉尾部捏造 —— 抬到 20 且超限取两端
- `c0bd0d2` feat(desktop): 历史日志批量回填 CLI —— 带磁盘护栏
- `b269b90` docs(handoff): §1 补上完整 7 维结果 —— 5/7 达标但先修 12 条上限
- `eaa2af1` docs(report): §0 范围更正 —— scores-det2 已是全 80 件,不再是 30 件
- `9f583be` docs(report): 完整 7 维 verdict —— 4/7 → 5/7 达标,但脆且有一个规则伪影
- `0df6532` docs(handoff): §1 硬待办已结案 —— 指向 2026-07-21 的验证报告
- `277e80d` docs(report): 第三轮 rubric 验证 —— 锚点噪声清零,查证漏检没动
- `4ded221` feat(eval): 判官方差判据固化为脚本 —— 主判据改「找到的错误集合」
- `30bd91b` docs(handoff): 全面接管指令 —— 判官方差是唯一硬待办,两个产品决定不许代拍
- `a80f3f6` docs(report): 修掉普查文档里的过期状态 —— §1 表和 §3 都还写着「未查」
- `aa1d5e4` docs(report): 漏驱散修复的全量数字 —— 822 → 2251 行,门规全绿无丢失
- `0294de7` docs(report): 漏驱散与折叠驱散的根因 —— 「空 77%」里 73% 是正确沉默
- `2f1954c` fix(analysis): 漏驱散白名单 9 条里 7 条是死的 —— 补齐圣骑士三祝福 + 加一致性断言
- `737e39c` docs(report): 普查四项逐条结论 —— P1 已修,P2/POSITIONING 无需动,P3 留给人定
- `bf17ccf` feat(analysis): 敌方技能组与友方同源 —— 补上 65% 场次的证据缺口
- `329589d` docs(report): 证据缺口普查 —— 65% 的场次敌方冷却完全没追踪
- `9e257f1` docs(handoff): 判官方差与 Layer B 阻塞 —— 有真待办
- `3d92ba3` docs(eval-baseline): accuracy 锚点改查表 + 数字主张必须并排写值
- `5e9415e` fix(eval): factAudit 长度约定放宽为 [3,12] + 如实记录 14.5 的未证实结果
- `cca541c` docs(eval-baseline): factAudit 审计集改为规则确定,accuracy 只按该集打分
- `f8a74cd` docs(backlog): n=10 校准定稿 —— 14.2 加重、新增 14.5(accuracy 判官方差)
- `6f267ec` docs(backlog): 订正 14.2 —— 20% 里混了套件缺陷,真盲区是 2/5
- `8713a6d` docs(eval-baseline): 给 accuracy 三条操作判据 —— 治渗漏,不只重申原则
- `751f6bc` fix(eval): 校准特异性检查豁免构造性耦合维度 + 报告点名漂移维
- `92f96d2` fix(analysis): 死亡下的 [RES] 快照锚定到死亡时刻,不再取 T-3s
- `4997308` fix(eval): 冷却台账门规改为带归属判定 —— 消掉 67% 假阳性
- `2967959` fix(analysis): [HEALER CC] 施放者标签改用共享谓词 actorLabel

## v0.0.16(2026-07-20)

- `29d1d57` release: v0.0.16 —— prompt 自相矛盾清零 + 模型下拉 + 回放/地图若干修正
- `00234cc` docs(backlog): 14.1 标记已修,并订正其中错误的根因猜想
- `11a677e` chore(qa): 重生成 report-replay 基线 —— 底图改为固定桩件
- `68635d3` test(visual): 桩底图改用非对称角标,中央留空
- `f6dce47` docs: 两份 handoff 完工归档为一份复盘,移入 docs/reports/
- `a4d2e87` docs(handoff): 清过期与冗余
- `65f795c` docs(claude): 加「修复要给前后数字」验证规则
- `50deb8f` docs(backlog): 记入 2026-07-20 eval/QA 四项遗留
- `13d656e` docs(handoff): 标记两项遗留待办已完成
- `258dcdc` docs(eval-ab): 开跑前必算 MDE —— 防再跑一轮测不出的 A/B
- `0eeabb2` feat(eval): D 类冷却台账矛盾入常驻门规
- `637ebd8` docs(handoff): 盲评 A/B 收官 —— 七维全 inconclusive,凭确定性 ADOPT
- `665346a` docs(handoff): 盲评 A/B 续跑交接 —— 卡在子代理配额,6/100
- `710ed5f` docs(handoff): 订正 D 类结论 —— 第一次判断是错的
- `c820ad4` fix(analysis): D 类真根因 —— 同一技能两个冷却值(订正先前的错误结论)
- `8f48174` fix(analysis): 漏驱散行的时刻改用 fmtTime —— 最后一处裸秒时间戳
- `0a193b0` docs(handoff): 8 类全部处理完毕 —— 补两档半径删除依据与 D 类结论
- `dbe61bd` revert(analysis): 删除两档 HP 采样半径 —— 建立在已证伪的根因上,且有害
- `7c7e9f6` docs(handoff): 千场复验结果 + D 类已确认/未坐实部分分开写
- `1f33b04` docs(handoff): 更新至 7/8 类已修 —— 含「先问同不同时刻」这条主教训
- `23de9f5` fix(analysis): I 类 —— OFFENSIVE WINDOW 的伤害数字与显示区间对不上
- `be36279` feat(analysis): F 类 —— 玩家自己施放的 CC 补齐 DR 标注
- `cd60380` fix(analysis): H 类时长自相矛盾 + E/G 记号图例与窗口口径自洽
- `f42fca1` fix(analysis): C 类同秒 HP 矛盾 —— 消掉第三条 HP 采样路径
- `0e13264` fix(analysis): A 类真根因是渲染网格不是采样半径 + B 类百分位倒置
- `a8afe37` docs(handoff): 补 C 类根因与待改调用点清单
- `3cd5342` fix(analysis): HP 采样半径收敛为单源谓词 —— 修同秒 HP 自相矛盾
- `9b8e40d` chore(qa): 重生成 report-replay / settings 视觉基线
- `18d5fad` chore(qa): presubmit 一键门禁 + 模型输出形态审计工具
- `43c6e2e` feat(report): 纯地图档高度可调 + finding chip 技能图标
- `132b3da` feat(ai): 模型下拉 + 本地后端透传 --model;修围栏输出被误判 bad-json
- `2159889` fix(replay): 开局位置盲窗标成「位置未知」,不再当确定位置画

## v0.0.15(2026-07-20)

共 64 个 commit,以下仅 feat/fix/perf(32 条):

- `e44814d` fix(qa): webServer 判据抽成带测试的纯函数;report-ai 锚点收紧
- `9e952bd` fix(test): 分栏用例显式清 localStorage —— 修 CI 上的状态泄漏
- `ac5a2d1` perf: 大 JSON 走 JSON.parse —— 冷启动 25s→2s,首渲 24s→0.8s
- `7c14f5a` fix(qa): 补掉最终审查的两处「门看着在守、其实拦不住」
- `3ba8014` fix(replay): 提示条补 Ctrl+滚轮/分隔条可拖 + 清理两处退化 CSS
- `66acec0` fix(visual): threshold 0.2→0.05 —— 默认容差放行了同亮度的配色改动
- `75b27f1` fix(visual): 容差改用绝对像素数 —— 1% 比例放行了真实配色回归
- `de40f09` fix(replay): 分隔条补 pointercancel/精确像素换算/键盘可达性
- `76778b5` fix(e2e): 补 resolveJumpTarget 单测 + openAiView 提到公共助手
- `5ac8c92` feat(main): GLADLOG_E2E userData 重定向 —— E2E 跑在临时状态上
- `4ac00ae` feat(replay): 地图与 GCD 泳道之间可拖分隔条
- `884f28e` fix(parser): 删掉 synthArenaLog 未实现的 rounds 参数
- `f483483` fix(fixture): 补 analysis.getState —— AI 视图在 fixture 下真的渲染 finding
- `165a178` feat(replay): 三档布局(补纯 GCD),解除地图 560px 硬顶
- `e3aa811` fix(replay-zoom): 清理孤儿 CSS + 补测试覆盖
- `6698482` fix(visual): per-test 超时提到 120s + 端口真正单源
- `004118b` feat(replay): 缩放按钮浮到地图右下角
- `4b56c7c` fix(replay): 已进入缩放态后裸滚轮也接管地图缩放
- `0c67fa0` feat(replay): 分栏比例状态与 clampSplitRatio
- `f07d7d9` feat(dev-ui): 仪表盘/设置/列表场景 —— app-shell 也进视觉回归
- `c7c07ba` feat(dev-ui): ?scene= 场景路由 —— 视觉回归的确定性入口
- `c72563c` feat(report): MatchReport 支持 initialView —— 视图可被 URL 直达
- `43f4b65` fix(deepdive): STAYED_IN 需付出真实代价才开深挖门 —— 判据与 formatter 同源
- `90a1e36` fix(desktop): getFlags 补 cancelled 守卫 —— 切场时旧场标记不再串台
- `624952c` fix(analysis): 目标死亡截断取最早一次,不依赖 deathRecords 有序
- `8a37def` fix(desktop): 代际条目回收 —— 但只在该场彻底静默时
- `1da25f9` perf(report): GcdSwimlane 布局 memo 真正生效 —— 依赖数组改稳定身份
- `5845f95` fix(deepdive): 占位符正则从 claimChecker 单源取 —— 别再各写各的
- `d4bf4b4` fix(desktop): 面板重挂改单次原子 getState —— 消掉「结果掉进缝里」的竞态
- `ce33ef9` fix(desktop): deepen 幂等守卫 —— 切页回来不再重复烧一轮深挖 token
- `536295c` fix(deepdive): focusT 锚最末锚点,不从被 clamp 的 anchorTo 反推
- `b7a7746` fix(desktop): running 追踪防泄漏(并发复审发现)—— 存代际按主人身份清 + abort 也清

## v0.0.14(2026-07-19)

- `1985247` release: v0.0.14 —— AI 分析切页不再丢失 + 未分析醒目大按钮
- `047b5c0` fix(desktop): AI 分析切页不再丢失 + 未分析时醒目大按钮

## v0.0.13(2026-07-19)

- `0b918a8` release: v0.0.13 —— 深挖轮(自动追问)覆盖死亡/走位/进攻失误 + 错题本
- `a81fc4c` docs(eval): 修正过时注释 五类→四类(juked-kick 已剔除)
- `6fbb4f9` test(eval): 进攻深挖大规模跨 AI A/B + 剔除弱类型 juked-kick
- `bdaf493` test(eval): 进攻深挖确定性扫描 + 扫描驱动的免疫门修正
- `1c85e9b` feat(deepdive): renderer 保底进攻深挖席位(survival≤2 + offensive≤1)
- `ad3aaac` test(deepdive): 断言生存-only pack 不印进攻图例(锁定门条件)
- `a477911` feat(deepdive): classifyFindingKind 分发 + prompt 进攻图例 + PROMPT_VERSION 12
- `0b6d8df` fix(deepdive): offensivePackItems role 用全名比较 + burst-start 条目补 inWin 守卫
- `76eed3c` feat(deepdive): buildOffensiveDeepDivePack + 纯映射核 offensivePackItems
- `c2ebd37` feat(deepdive): 进攻信号门 hasOffensiveCoachableSignal + PackItem kind 扩展
- `b073b94` docs(plans): 进攻深挖(非死亡 finding 深挖)实现计划
- `b1035bf` docs(specs): 进攻深挖(非死亡 finding 深挖)设计 + backlog #13
- `c55929d` test(eval): 走位信号价值 eval 谐波 —— 盲评生成 + 回构审计
- `11b5b51` feat(deepdive): 走位失误第四类信号 —— 补资源信号看不见的「死于走位」缺口
- `10c5112` test(eval): 逐 spec 信号分解 —— 诊断过门率差异根因(结构性 vs 覆盖缺口)
- `e66fe81` test(eval): 深挖大样本鲁棒性扫描 + prompt A/B 工具
- `f379503` feat(analysis): 深挖修 1+2 —— 可教信号门(防御Early/Late/≥3s硬控该交没交/驱散撞敌CD,门移到调用方)+ owner 锚定与 role 标签 + 干净窗口留白;PROMPT_VERSION 10
- `cf1ccfd` fix(analysis): 深挖 prompt 纪律修正(eval 驱动)—— 去 units 幽灵字段 + HP 拆逐检查点占位符 + facts 短名去 realm 数字;PROMPT_VERSION 9
- `59a75be` test(eval): 深挖轮量化脚本 —— 证据产出量(模型无关)+ 纪律 smoke(生成/审计两段)
- `858c46f` feat(analysis+desktop): 深挖轮(自动追问)—— 高严重度 finding 确定性证据包扩容([锚点-30,+10] 受控/防御/敌CD/HP轨迹/驱散)+ 第二轮叙述经 claimChecker+causalLint 审计 + 证据 chips 可跳回放;PROMPT_VERSION 7
- `cdb28cb` feat(analysis): death-setup 死因链候选 —— 死亡回溯前因事件(healer-locked/trinket-early/defensive-early,谓词镜像 death-trace)+ prompt 链条图例与死亡锚定上限 + max_tokens 4096 + PROMPT_VERSION 6
- `f1fcc04` feat(desktop): 错题本 —— 跨场 findings 按类型分组(main notebook 服务 + 战绩页内嵌展开卡:meta/标记/打开该场)
- `60392b1` docs(skills): agy-review skill(输出截断坑+采纳标准)+ desktop-dev 门禁改全仓 lint + cd 陷阱
- `7608d72` docs(skills): release skill —— tag 驱动出包/覆盖流程 + 资产验收 + 坑单

## v0.0.12(2026-07-18)

- `4f57f87` feat(desktop): 回放纯地图/GCD 布局切换(localStorage 记忆)+ 开发者页 AI 调用调试(最近 10 次 prompt/返回,内存不落盘)
- `1690a2e` feat(desktop): cohort 评分长条视觉增强 + AI 分析/对比合并为一个按钮(runSignal 联动)
- `2cdf2d6` feat(desktop): 0 finding 分因解释 —— fallbackReason(无候选/未配AI/坏JSON)+ 全被审计丢弃中文提示替换英文占位
- `7616a5c` release: v0.0.12 —— 首次加载提速(WeakMap memo/worker parse+LRU/bundle 拆分 19MB→2.1MB)+ tab 靠左
- `f35ee7a` chore: 外部评审可取两项落地 —— timeline spec tag 单测 + iconCache 缓存策略注释
- `7fa954d` feat(desktop): tab 位置调整 —— App 顶栏与战报页头的视图 tab 靠左(用户反馈),胜负+meta 推右
- `783657b` fix(desktop): matchStore 探针测试 console.log→warn(CI 全仓 lint)
- `d4c6342` perf(desktop): bundle optimization using top-level await dynamic imports for spellNames and talentIdMap
- `52e965f` perf(desktop): parse match file in worker thread and implement LRU cache
- `85474e6` perf(desktop): memoize toLegacySafe with WeakMap to speed up first load
- `c918779` docs(plans): 首次加载提速任务书 —— 全链路实测基线 + 三改法(memo/worker parse/bundle 拆分)

## v0.0.11(2026-07-18)

- `7cda727` release: v0.0.11 —— 全模块 UI 重设计(accent 夜蓝语言/战报时间轴脊柱/回放两侧框体/评分带) + 小地图专精图标 + cohort 评分化
- `f8b6301` fix(desktop): 重设计复核修正 —— 评分源同类相比(CR/MMR 不混)/当前评分基线守卫/跟进标记出证据守卫/回放光标投影(卸载回报)/死亡回顾卡 1c 样式/角色 chips accent 胶囊/CSS 去重(agy flash 复核 7 条)
- `930ca53` feat(desktop): UI 重设计 P7 战报 1c —— 单行页头+tab 同排/曲线卡 240 高+死亡圈标/窗口列表行(可点跳)/榜单|死亡回顾常驻两栏/榜单职业字形方块
- `d618d9f` feat(desktop): UI 重设计 P6 回放 1f —— 框体贴场地两侧/控件条重排+快捷键提示/泳道 5s 分隔带+光标徽标+大招 accent chip
- `0ffef99` feat(desktop): UI 重设计 P5 AI 分析 1g —— 操作区置顶+状态行(撤 MatchHero)/时刻轴单侧左轨/finding 标签化/cohort 分布条+游标(判定文本保持 faithfulness 锚定)
- `813b8ea` feat(desktop): UI 重设计 P4 战绩 1h —— 总览数字带(当前评分/涨跌派生)/曲线轴刻度+端点标注+图例/阵容胜率条/问题行式
- `c6c4792` feat(desktop): UI 重设计 P3 对局列表 1e —— 左缘胜负线/评分涨跌/日期分组头+当日小结/HH:MM/筛选条统一
- `08a65a2` feat(desktop): UI 重设计 P2 设置 1i —— 三列 grid/统一输入框/已设置胶囊/就地保存反馈/后端说明行
- `003a1e9` feat(desktop): UI 重设计 P1 —— accent tokens/Inter/两级 tab 形态/交互金→accent(数据金保留:击杀带/未按/控制字/kill chip/recent GCD)
- `d2070f2` docs(specs): UI 重设计交接稿收档(1c/1e-1i 全模块 + accent tokens)
- `0fd5605` feat(desktop): cohort 面板评分化 —— 方向修正评分单源(METRIC_LOWER_IS_BETTER)+ 评分条 + 确定性总结行(综合/最强/最弱)
- `1d9f1af` feat(desktop): 回放场上单位叠加专精图标(CDN 同列表先例,失败回退职业字形)

## v0.0.10(2026-07-18)

- `85ecb67` fix(desktop): 回放 UI 复核修正 —— smoothPath 端点/x 钳制,框体死亡判定改 deathT 谓词(agy flash 复核)
- `d10a575` feat(desktop): GCD 泳道两队分组 —— 友方列在左敌方在右,交界分隔竖线
- `449cd19` feat(desktop): 战报血量曲线平滑 —— Catmull-Rom 贝塞尔 + 控制点钳制防过冲 + non-scaling-stroke
- `47c6c05` feat(desktop): 回放竞技场框体侧栏 —— 友/敌两组血条常驻可读,hover 联动高亮+raise,替代旧 legend
- `1370f41` release: v0.0.10 —— 关键时刻轴 + 列表后台补载/战绩动态更新 + 战报明细 breakdown
- `1481898` docs: backlog #11 标记完成 + breakdown 实现计划入库
- `1750f55` fix(desktop): breakdown 复核修正 —— 点击区改真实 flex 盒 + 展开数据 useMemo + 宠物名不切分/同名不同服回退全名(agy flash 复核)
- `293536f` feat(desktop): 战报明细 breakdown —— meters 行内展开按技能/来源分解(backlog #11)
- `a4f33ba` feat(desktop): deriveDetailBreakdown —— 按技能/来源聚合,合计与 meterValue 对账
- `0a1bc18` feat(parser): decodeHpTail/hpTailSlice 导出 —— hp 尾参解码单源,parseLine 改用同一切片
- `24b1799` docs(specs): 战报明细 breakdown 设计(行内展开 + 核心列 + 暴击率,决策记录)
- `cf802d7` docs(backlog): #12 标记完成
- `f284d18` feat(desktop): 列表后台补载 + 战绩随入库动态更新(backlog #12)
- `751030b` fix(desktop): axis 复核修正 —— 被控节点带施法者 + useMemo 归并/分流 + 纯渲染 gap + 稳定 key(agy flash 复核)
- `cbbe235` feat(desktop): AI 分析页关键时刻轴布局 —— 轴替换横向 strip,cohort 全宽下沉,整场观察分节
- `da62316` feat(desktop): KeyMomentAxis 组件 —— 交错脊柱/省略标/点跳
- `ea8bf25` feat(desktop): deriveKeyMoments —— 关键时刻轴五类事件派生(谓词全复用 analysis)
- `62523ae` docs(backlog): #12 懒加载后台补载 + 战绩动态更新(用户反馈)
- `c12f586` docs(backlog): #11 战报明细 breakdown(按技能/来源分解,原版 detail 级)
- `714157b` docs(specs): AI 分析页关键时刻轴设计(用户批准的四项决策记录)

## v0.0.9(2026-07-18)

- `b9fb721` release: v0.0.9 —— 证据时间 chip + unconverted-burst 证据类型 + findings 3-5 条
- `ff2302b` feat(analysis): unconverted-burst 候选类型 + findings 提到 3-5 条(证据多样性)
- `cec89c5` feat(desktop): finding 证据加时间 chip —— 每条证据显示发生时刻,单独可点跳回放

## v0.0.8(2026-07-18)

- `0274b64` release: v0.0.8 —— 对比中文化/解说增厚/泳道截断
- `70606a4` feat(desktop): 对比面板全面中文化 + 解说增厚;回放泳道结束线截断

## v0.0.7(2026-07-18)

- `6181db4` release: v0.0.7 —— 后端命令路径手动设置
- `9aa71af` feat(desktop): 设置页补「命令路径」输入 —— Claude CLI/agy 后端可手动指定
- `25cdb67` docs: Windows + Claude CLI 安装指南(发同事用)

## v0.0.6(2026-07-17)

- `85c99a9` release: v0.0.6 —— 回放场地边界/入场房轮廓 + ⌘/Ctrl 滚轮缩放
- `e0d06b3` feat(desktop): 回放场地边界/入场房轮廓(语料实测)+ 缩放交互改 ⌘/Ctrl+滚轮

## v0.0.5(2026-07-17)

- `64881e3` release: v0.0.5 —— 覆盖尾巴清零 + 七个失明 CC + SPEC BASELINES 复活 + 敌方饰品行
- `b1ac13c` docs(plans): 超长对局加载优化设计 —— 主进程同步 parse 三重成本 trace + 方案 A
- `c9d6f0f` fix(analysis): benchmarks 千场重算 + 修活死键 SPEC BASELINES(第 15 例谓词分裂)
- `77c1b57` fix(analysis): [OFFENSIVE WINDOW] CD 带施放时刻 + 第 7 个失明 CC(agy 交叉复核)
- `5f16de9` fix(eval): rotScan 未用变量 —— CI lint 含 scripts,本地 --quiet 输出被截断漏看
- `cd0dc4b` feat(desktop): UI 压测样本池 —— 野生边界 fixture 生成/按需加载/headless 冒烟
- `41baa6c` fix(analysis): CC 白名单光环 id 腐烂 —— 千场语料实证补全 6 个失明 CC
- `601c959` fix(analysis): 覆盖尾巴清零 —— owner 无CD CC 上时间轴 + 双侧宠物驱散 + 敌方饰品行
- `d6f7cf2` fix(analysis): CC 行宠物施法者归因 + 千场野生 fuzz 工具
- `49046ba` fix(corpus-tools): comp tier 测试改静态导入 —— 冷 CI 动态 import analysis 超 5s 超时
- `ada128a` feat(compare): P2 对阵 comp 维度 —— 同阵容高手 cell + 时长/先杀 + comp tier 回退链
- `104dbd5` docs(plans): pro-comparison P1 勾选(387 cells,262 DPS)
- `6ea230f` fix(corpus-tools): union metrics 转 Record 需经 unknown(workspace tsc 含 src 测试)
- `f4e9845` feat(compare): 高手对比 DPS 指标组(P1)—— 7 维进 reference corpus,262 个 DPS cell
- `779a53b` docs(plans): 高手对局深度对比设计 —— 情境化指标/comp 维度/exemplar 导入
- `edd394f` fix(desktop): 缩放测试 className 类型(CI workspace tsc 含 test 文件)
- `6217aa5` fix(desktop): 缩放 handler prefer-const(lint)
- `dd431a5` feat(desktop): 回放缩放 + 战绩角色区分 + Windows 本地 CLI 后端
- `110bfff` refactor(logs): 日志收集工具整合 —— 共享 wowarenalogs 客户端 + 统一 logs:* 入口
- `753b674` ci: test workflow 加 electron-vite build 步 —— renderer 值引入 main 只有生产打包能抓

## v0.0.4(2026-07-16)

共 126 个 commit,以下仅 feat/fix/perf(89 条):

- `3a9ccc8` fix(desktop): API_KEY_REDACTED 移入 shared/protocol —— renderer 值引入 main 模块炸生产构建
- `6b697e7` fix(analysis): DPS baseline Top-3 修复 —— interrupt 字段语义统一 + kick 判定两 bug + 窗口截断 + 主语措辞
- `9836b74` feat(eval): 公开对局抓取器 —— 真 DPS 视角语料管线(D2 收尾)
- `1ac01b8` feat(desktop): 本场目标卡(D3 教练闭环)—— 「还在犯」分类进 AI 视图开场
- `d0c7089` fix(analysis): 爆发账本减伤行写明主语 —— 冒烟实测 responder 误读为己方外置
- `e3ee234` fix(eval): DPS 语料支持 —— --owner dps + 门规主语解析三修
- `0545421` feat(analysis+desktop): D2 —— AI 复盘 owner 视角泛化,DPS 记录者获 <burst_ledger> 与四类新事件
- `c83ba7a` feat(desktop): 回放爆发红光脉冲 + 同秒集火高亮(DPS D1 收官)
- `b9910a6` feat(desktop): DPS 爆发账本卡(D1)—— 爆发对齐/窗口目标纪律/打断审计
- `558359e` fix(analysis,eval): DR 图例消歧 + responder 聚焦句(baseline Top-2/3 issue)
- `602ed11` fix(analysis): 覆盖门三连修 —— 敌方宠物 CC / 敌方队内解 / 我方 CC 落敌不可见
- `b555dd9` fix(analysis): benchmarks 重生成 —— metrics 符号修复后的真实 DPS 基线
- `05bb089` fix(desktop): 移除未使用的 findingKey import(CI lint 挡了两个 commit)
- `59a586b` feat(desktop): 回放小件三连 —— 键盘操控 + 障碍物描边 + AI 流式预览(phase3 #4)
- `fd134a3` feat(desktop): 最常犯的问题聚合卡 —— 教练从点评变跟进(phase3 #3b)
- `d0369e8` feat(desktop): finding 跟进标记 —— 已跟进/还在犯(phase3 #3a)
- `7641d7b` feat(desktop): 历史日志导入 —— 文件对话框 → 解析入库 + 进度(phase3 #2c)
- `bb44c13` feat(desktop): 首启引导空态(phase3 #2b)
- `eaf37db` feat(desktop): 设置页 —— 用户项的正式家(phase3 #2a)
- `5726e52` feat(desktop): 战绩仪表盘 —— 跨场统计首落地(phase3 #1)
- `6925b41` feat(desktop): 战报 HP 时间轴画 KILL WINDOW/VULNERABLE 色带(可点跳回放)
- `d553b57` feat(desktop): 泳道阵亡 divider 可点 → 死亡回顾 —— 三处死亡标记入口齐活
- `bea7cd0` feat(desktop): 对局列表筛选条 —— 胜负/赛制/专精(对齐旧仓 MatchSearch)
- `454bdc1` feat(parser,desktop): 真读条条 —— SPELL_CAST_START 落地 + 回放读条进度(#11b 完全版)
- `45d0f0d` feat(desktop): 窗口色带可点 —— 点 burst/vulnerable 带直达该时刻
- `4f322c4` feat(desktop): 回放阵亡 ✕ 可点 → 死亡回顾(#6 v2)
- `f83228e` feat(desktop): 泳道 chip 点击定位 —— 点任意施法把共享时钟 seek 到该时刻
- `2c666ce` feat(desktop): 统计表行展开 —— 打断/被控实例明细 + 回放跳转(#10 v2)
- `8fca726` feat(desktop): AI 分析语言切换 中文/EN(backlog #1)
- `c03731f` feat(desktop): 回放三小件 —— HP 数字 + dampening 指示 + 施法闪现(backlog #11)
- `f32a4d2` feat(desktop): 统计表 —— 打断/被控/驱散每玩家硬数据(backlog #10)
- `b2fc00f` feat(analysis,desktop): 泳道技能图标 —— spellId→图标名挖掘表 + chip 渲染(backlog #9)
- `3501c76` feat(desktop): 死亡回顾抽屉卡 —— 点死亡标记看死前 10s + 可用未按保命(backlog #6)
- `b825184` feat(desktop): #8 收尾 —— TimelineStrip「回放此刻」+ KILL WINDOW/VULNERABLE 色带
- `8772f4f` feat(desktop): 对局列表富行 —— 胜负/地图/时长/评分 + 双方专精图标(backlog #7)
- `60d9707` feat(desktop): 证据链跳转 —— finding「回放此刻」直达事件时刻(backlog #8 核心)
- `852a136` feat(analysis): KILL WINDOW 重设计 —— 脆弱状态 vs 击杀尝试分离(burst 子窗口)
- `e3c1708` fix(analysis): 专精级覆盖排查 —— 12.x 爆发 CD 补齐 + Shadowfury DR + 7 个缺失打断
- `4cce06d` fix(analysis): OPPORTUNITY 行按时间渲染(选杠杆、排时间)—— 136/1245 乱序
- `5aa94e1` fix(analysis): 伤害符号约定 bug —— 'your damage' 全线只统计了被吸收伤害
- `f7a6251` fix(analysis): 不变量扫描再两修 —— kill-window CC 成员判定对齐渲染秒 + 引导施法注释自相矛盾
- `1aacaa5` fix(parser,analysis): 不变量扫描两修 —— shuffle 回合尾巴吞局间空隙 + CD 变体 id 误标 UNUSED
- `8181ef7` fix(analysis): Stasis 存储法术白名单补 4 个 12.x id —— 24/51 释放少列法术
- `6215390` fix(analysis): [MATCH TYPE] 头部预判框架 → 带对冲的 [MATCH PATTERN];产品提示词加 A/B 证据注释
- `ced551a` feat(eval): responder 模板加 ACCURACY DISCIPLINE 自查段(A/B: accuracy +0.71 CI 胜)
- `57d27f8` fix(analysis): labelBias 两处收敛信号 —— DMG SPIKE healed-through 标注 + 中性 exposure 判词
- `ec9a7c6` fix(analysis): RES 滞后 + STAYED_IN 窗口语义 + Sigil of Misery DR 标签(Gemini 评审三修)
- `f58ebc4` feat(analysis): 高频填充施法窗口折叠 + 引导 tick 抑制(降噪 A/B treatment)
- `aceafb5` fix(analysis): G5 扫描锚定渲染秒(floor)—— 1114/1021 残留根因
- `3cb15ea` fix(analysis): [CD] 目标标签最后两处 CJK 泄漏 —— pid 回退路径
- `315b224` fix(analysis): G5 take 2 —— LoS 判定改为与门规完全一致的 ±2s 扫描
- `83d4600` fix(analysis): last two locale-leak sites — [UNIT DESTROYED] + [CD] target labels
- `84bae32` fix(analysis): track Devourer Demon Hunter kit + Sigil of Misery CC
- `c0711f7` fix(analysis): evaluate LoS at raw sampled positions, not interpolated (G5 residual)
- `a3a75fb` fix(analysis): make INACTIVITY 'free' wording explicit (un-CC'd, could have cast)
- `0e360fe` fix(analysis): shared bounded HP sampler — death traces provably match STATE (B4 residual)
- `57a20fd` fix(analysis): resolve pet/NPC names in [KICK] lines (last locale leak)
- `8f5b255` fix(analysis): explicit "DAMPENING: n/a" line for short matches
- `7295177` fix(analysis): track missing enemy burst CDs (21% of corpus had zero [ENEMY CD])
- `69be1f3` fix(analysis): detect Grounding Totem absorbs by npcId, not English name
- `09cb414` fix(eval): SPECIFICITY_TOL default 0 -> 1 for the integer judge rubric
- `1e3bc3d` fix(analysis): bound position interpolation in healer-exposure LoS checks (G5)
- `4d65dbb` fix(eval): extend dispel-oracle rider exclusions found at 1245-match scale (B3)
- `c1f3fff` fix(analysis): unify burst-target attribution + tighten burst HP sampling (B4)
- `5f70143` fix(analysis): suppress localized totem/pet target names in timeline (locale leak)
- `c52ea5b` fix(analysis): render English spell names in offense/CC prompt sections (locale leak)
- `8c355a2` fix(eval): judge rubric 维度独立性 anti-halo rule (discriminant validity)
- `2188ec0` fix(eval): judge-calibration 判别效度 —— 特异性/最小样本/降幅门槛
- `bda41bf` fix(desktop): 修好 in-app fixture 预览(VITE_FIXTURE_MODE=1 npm run dev)
- `283fe30` fix(desktop): GCD chip 只显示技能名,目标移到 hover
- `1bbbae7` feat(desktop): 回放竞技场铺真实地图(按 zoneId 对齐 minimap)
- `3fb8c5f` fix(desktop): GCD 技能暂停时不压暗(只在播放时暗未来动作)
- `bc13036` fix(desktop): GCD 技能 chip 加高(上下更宽,更好读)
- `381f534` fix(desktop): 回放布局改 1:2(竞技场 : GCD 泳道),收紧中间间隙
- `56ed402` fix(desktop): 回放 GCD 泳道加宽放大(往左拉、字更大更清楚)
- `5413d7c` feat(desktop): GCD 泳道降密度 + 战报点名字筛选生命曲线
- `0df1479` feat(desktop): 本地 UI 试验台(npm run dev:ui)—— 纯浏览器渲染战报
- `e639493` feat(desktop): redesign AI 视图 — 双栏 findings 卡片 + sticky cohort
- `844caa9` feat(desktop): View C GCD 模式泳道(与竞技场共享时钟)
- `3d29414` feat(desktop): redesign View C 回放 — WoW 竞技场风格
- `821b741` feat(desktop): redesign View A — 段控视图 tab + 榜单内嵌模式切换 + 删单位侧栏
- `b5906c0` fix(vision): address agy cross-family review (C1)
- `abc6724` feat(vision): headless verify:vision script (C1)
- `7cd0c77` feat(vision): cohort selector + faithfulness checker (C1)
- `a69e662` feat(vision): timeline selector + faithfulness checker (C1)
- `cef0c97` feat(vision): meters selector + faithfulness checker (C1)
- `67d7d87` feat(desktop): 回放 Tab —— 2D 走位模拟(轨迹/阵亡/图例)
- `afd0dc8` feat(desktop): 单位详情合并施法+重要光环流 & 玩家筛选下拉
- `3807cce` feat(desktop): AI 分析拆成独立全宽 Tab(脱离右侧窄栏)

## v0.0.3(2026-07-12)

- `04b0f4c` build(lint): allow require() in .cjs files (electron-builder hooks)
- `fc55952` chore(desktop): bump version to 0.0.3
- `8710d4b` docs: /release-gladlog command — versioned desktop release workflow
- `5757fe4` feat(desktop): debug local-AI backend (claude/agy CLI)
- `136cb0c` docs(specs): debug local-AI backend (claude/agy CLI) design
- `b46fa73` build(desktop): afterSign hook — clean ad-hoc macOS signature (no more 'damaged')

## v0.0.2(2026-07-12)

- `bc45ba5` chore(desktop): bump version to 0.0.2
- `03641f6` perf(desktop): append-only NDJSON match index — one-read startup + O(1) store
- `ee3b37f` feat(desktop): infinite-scroll match sidebar (initial 100, older on scroll)
- `5874f51` feat(desktop): matches:page IPC + preload bridge
- `170def9` feat(desktop): MatchStore.page() paginated slice
- `3cc963c` docs(plans): match-list pagination + NDJSON index implementation plan
- `dc7e6fe` docs(specs): match-list pagination + fast-startup NDJSON index design
- `315814a` ci: let macOS build ad-hoc sign (drop CSC_IDENTITY_AUTO_DISCOVERY=false)

## v0.0.1(2026-07-12)

共 226 个 commit,以下仅 feat/fix/perf(157 条):

- `1d220ff` fix(log-pipeline): append-only reconstruction + review nits
- `50d1f94` feat(log-pipeline): collect CLI + cleanup tests
- `1eaa7d3` feat(log-pipeline): port cleanupAppliedSegments (node:fs + gzip-length cross-check)
- `ff940db` feat(log-pipeline): overlap-aware gunzip-validated collection
- `757ee57` feat(log-pipeline): length-encoded segment keys + flusher wiring
- `5475586` feat(log-pipeline): stage ported streamer + storage/protocol infra (raw port, pre-hardening)
- `c226d4b` feat(analysis): expand findings menu — side-tagged deaths + cd-waste events
- `cdebdf1` fix(analysis): honesty-pipeline bugs from agy cross-family bug-hunt
- `70da433` fix(analysis): three verifiedComparison bugs surfaced by the smoke test
- `4905b59` feat(analysis): harden findings prompt against raw digits (SP-A.1 digit refinement)
- `bf907fd` fix(analysis): R3 — render offensive-waste block in the timeline branch
- `ab05545` fix(SP-A): narrow causalLint patterns to cut false-drops (agy re-verify)
- `2ff8aec` fix(SP-A): close two honesty holes from Opus whole-branch review
- `a4afff4` feat(desktop): ExportButtons + StructuredAnalysisPanel replacing the <pre> analysis (SP-A T7)
- `308aa4d` feat(desktop): FindingsList + MatchHero + TimelineStrip (SP-A T6)
- `6bdca5e` feat(desktop): main-process analysis service + IPC/preload (SP-A T5)
- `43d6965` feat(analysis): findings prompt + analysis exports (SP-A T4)
- `a85a084` feat(analysis): auditFindings three-layer gate (SP-A T3)
- `1046bf9` feat(analysis): causal-language lint (SP-A T2)
- `e867e50` feat(analysis): candidate-event types + extraction (SP-A T1)
- `e6c07f1` fix(SP-B2): reset compare panel state + guard async race on matchId change
- `1407a00` fix(SP-B2): address Opus whole-branch review findings
- `9613971` feat(desktop): ProComparisonVerified panel (SP-B2 T7)
- `39ac7a8` feat(desktop): corpus loader + compare IPC/preload wiring + bundling (SP-B2 T6)
- `0899967` feat(desktop): main-process compare service with fail-open + claimChecker (SP-B2 T5)
- `63249ba` feat(analysis): exemplar-led prompt + compare exports (SP-B2 T4)
- `f3e7dcc` feat(analysis): template interpolation + claimChecker gate (SP-B2 T3)
- `4b12832` feat(analysis): verifiedComparison + facts dictionary (SP-B2 T2)
- `b7c7764` feat(analysis): compare corpus read-types + cell lookup fallback (SP-B2 T1)
- `f9f1673` fix(SP-B1.5): address agy whole-branch review findings
- `a05f9d3` fix(corpus-tools): aggregateCells self-guarantees the buildGroups invariant
- `6b30dd3` feat(corpus-tools): maintainer keystone-discovery tool (SP-B1.5 T7)
- `1e02d29` feat(corpus-tools): thread keystone gates through buildCorpus (SP-B1.5 T6)
- `3892072` feat(corpus-tools): validate build-group schema integrity (SP-B1.5 T5)
- `c3ff208` feat(corpus-tools): build-split cells + N_floor guard + buildGroups (SP-B1.5 T4)
- `9d39e0b` feat(corpus-tools): winsorize offensiveIndex to pool p99 (SP-B1.5 T3)
- `1ebeefb` feat(corpus-tools): assign buildGroup per record via keystone gate (SP-B1.5 T2)
- `2f342f8` feat(corpus-tools): keystone gate module + curated table (SP-B1.5 T1)
- `b0090a1` feat(corpus-tools): retry-with-backoff on feed calls for production-scale runs
- `2bcb0cc` fix(SP-B1): address final-review Important findings (latent safety-net gaps)
- `c6b0cc6` feat(corpus-tools): T8 real corpus build + 2 metric fixes found by acceptance gates
- `0c6b7e8` feat(corpus-tools): per-match record + buildCorpus orchestration (SP-B1 T7)
- `35f37a8` fix(corpus-tools): feed query needs inline fragments on ArenaMatchDataStub/ShuffleRoundStub (go/no-go smoke diagnosis; direct field selection on CombatDataStub interface → HTTP 400)
- `2727cce` feat(corpus-tools): feed client + go/no-go smoke (SP-B1 T6)
- `481bb57` feat(corpus-tools): corpus validator hard gate (1.5 sentinel/ASCII/N_floor) (SP-B1 T5)
- `9392e73` feat(corpus-tools): scaffold package + cell aggregator with archetype celling + N_floor (SP-B1 T4)
- `3817d11` feat(analysis): enemy-comp archetype classifier for cohort celling (SP-B1 T3)
- `4a4a02f` feat(analysis): port extractRotations/crisisEvents from old fork (SP-B1 T2)
- `ecdb8cf` feat(analysis): port computeHealerMetrics from old fork (SP-B1 T1)
- `2ee7ee2` fix(analysis): restore death-outcome block + never-used flag in timeline prompt (E2E regressions R1+R2)
- `154d38c` feat(analysis,eval): dispel visibility — named dispel spells on [CLEANSE], team [PURGE] + [ENEMY PURGE] lines, folded [MINOR DISPELS]; manifest excludes movement root-breaks from dispel denominator (backlog #5)
- `f004d74` feat(eval,analysis): geometry grounding scanner + pipeline guards — 176-match corpus at 0 violations (backlog #3 hard gate)
- `22f7565` feat(eval): CONTESTED safety-contract assertion script (F193 replication) — 176-match corpus clean; F193 rubric clause added to eval-baseline accuracy dim. Backlog #4 closed
- `ed29c81` feat(desktop,eval): adopt timeline prompt variant as production default
- `ac35614` fix(parser): strip trailing \r from CRLF logs — feign deaths were recorded as real deaths; timeline: STATE min-gap 3s + delta [RES] on CD casts (A/B cycle-3 density compression)
- `0e6d5c4` feat(analysis): timeline unit references carry compact spec tags (A/B cycle-1 accuracy-regression fix)
- `3e4adf4` fix(analysis): owner-perspective Result line + neutral section headers (baseline eval findings)
- `d68f8d1` fix(review): sub-project 5 findings — unsigned mask decode, build-string validation, icon fetch budget, test-hack removal
- `c3c6e64` feat(report): talent icons with local disk cache (zamimg, offline-degrading) + update-wow-data workflow + datagen manifest
- `7dd1f93` feat(report): named talents in unit panel (getTalentNames via raidbots node maps)
- `f77afd5` feat(datagen): spell-class map + catalog validation (known-removed allowlist: Mind Bomb kept for historical logs)
- `a08df98` feat(datagen): own generators ported (trinkets, talent modifiers) + regenerated artifacts (build 12.1.0, 129 tracked spells)
- `9b1134c` feat(analysis): two-layer spell effect data (generated base, curated overrides win)
- `e2bd7b9` feat(datagen): spell effects miner (PvP-duration-aware, GCD-artifact filter) + generated base layer (3560 spells)
- `a611d42` feat(datagen): spell names regenerated from wago (enUS, minified, 413k entries, 13MB→12MB)
- `d6e8ba0` feat(datagen): raidbots talent fetch + real talentIdMap (40 specs, activates named-talent decoding)
- `1354e16` feat(datagen): wago csv + emit foundations
- `5b62fb0` fix(eval): final-review findings — blinding protocol, strict score schema, auditor robustness, CLI parity
- `6927ece` fix(eval): review findings — LCG strict [0,1) bound, dimensionScore numeric-string coercion parity
- `b01edc2` fix(eval): checkProvenance CLI accepts BASE_DIR without --run; e2e smoke pass
- `b71163f` feat(eval): score provenance validation (strict, no legacy leniency) + spot-audit/auditor-calibration ports
- `cba3178` feat(eval): judge calibration suite port
- `a09b091` fix(eval): corpus result is owner-relative Win/Loss/Unknown (ledger + calibration contract)
- `4d7446c` feat(eval): blind AB pool + paired stats port
- `0dfa847` feat(eval): deterministic prompt quality checks port
- `05536e9` feat(eval): corpus builder (gladlog parse chain, healer-owner prompts)
- `ec0439a` feat(eval): coverage manifest port
- `34315ae` feat(eval): eval-home resolver and private-repo init CLI
- `42c6ed1` feat(eval): package scaffold
- `6d2ce88` fix(review): final-review findings — AI stream race, key redaction, stream abort, pass2 id parity
- `1d586c4` fix(review): T2-6 review findings — params hardening, DR entries, API exports
- `d9a7024` fix(analysis): benchmark CLI parse-chain (correct GladLogParser API, glad-id keying, two-pass) + streaming aggregation; real-corpus benchmark_data (200 logs, 346 combats, 27 specs)
- `d6010e3` feat(analysis): local-corpus benchmark rebuild — stratified sampling, metrics core, CLI (haiku subagent)
- `d0e271d` feat(desktop): AI analysis panel wired to report page (unit/AI side tabs)
- `32df349` feat(desktop): main-process Anthropic streaming ai service (haiku subagent impl per degradation chain)
- `c54d051` feat(analysis): batch C + buildMatchContext port — full prompt pipeline green (459 tests)
- `e06f4d6` feat(analysis): core batch B port (dr/ccTrinket/dispel) + owned DR table; compat extra-spell fields
- `a7cbf6b` feat(analysis): core batch A port (cooldowns/enemyCDs/offensiveWindows) + catalog calibration via own tests
- `880fa92` feat(analysis): base utils port + owned classSpells/spellIdLists catalogs
- `ef34cf1` feat(analysis): data layer port — curated spell categories/effects, local SpellTag, talentIdMap placeholder
- `f47badd` feat(analysis): data layer port with curated spell-effect overrides
- `8f42be0` feat(analysis): package scaffold
- `7bf8c4d` fix(desktop): remount reports on doc switch (key); merge pet absorbs into owner; show build summary in unit panel
- `1fbd4b5` fix(desktop): bridge indirection — fixture override slot, contextBridge prop is read-only
- `7354548` feat(desktop): match/shuffle report assembly, fixture bridge, app shell restructure
- `70a3471` feat(desktop): SVG timeline (d3-scale) + unit detail panel
- `ffb3e46` feat(desktop): report header + meters components with jsdom test setup
- `f46c97e` feat(desktop): class colors/names + spec names incl. runtime-observed 1480 Devourer DH
- `3b14598` fix(desktop): death marks include players without combatant info
- `5c9271d` feat(desktop): cast and aura sequence derivation
- `f331308` feat(desktop): timeline derivation — hp series + death marks
- `9c47022` feat(desktop): unit summary derivation with pet merge
- `9c58353` feat(desktop): report derive types + roster derivation
- `8fc5268` feat(desktop): sanitized report fixture (self-collected 2v2) + generator script
- `9a0026e` fix(desktop): fatal parse errors crash worker for quarantine attribution; persist quarantine across reconfigure
- `68a68df` fix(desktop): process rename events in watcher — macOS reports new files as rename; tail reader tolerates races
- `a2a0f84` feat(desktop): log replay script for e2e acceptance
- `1eaa0ee` fix(desktop): build preload as CJS — sandboxed preload cannot load ESM, window.gladlog was never injected
- `4ccc4c7` feat(desktop): debug-grade live UI — status, match list, detail, diagnostics
- `dd858fd` fix(desktop): self-heal match dirs with corrupt meta (rm before rename); pin app name for stable userData
- `59b00da` feat(desktop): main-process assembly, typed IPC bridge, preload api
- `509f5a6` feat(desktop): match store — atomic meta/match/raw persistence with idempotent dedupe
- `cf6ea25` feat(desktop): worker host with crash attribution and per-file quarantine
- `5bc4330` fix(desktop): advance tail state only after batch fully fed to parser (no silent drops on push throw)
- `c724089` fix(desktop): guard tail reader against TOCTOU file deletion between stat and open
- `1452b34` feat(desktop): worker runtime — configure/scan/watch loop with checkpoint persistence
- `6daa66f` feat(desktop): file pipeline with safe-boundary checkpoints and rotation reset
- `15027d3` feat(desktop): byte-accurate tail reader with rotation/truncation detection
- `eb35f6d` feat(desktop): event-driven log watcher (ported own windows-agent watcher)
- `27dd8d7` feat(desktop): atomic checkpoint registry (ported own state.ts pattern)
- `3f8de42` feat(desktop): WoW dir detection + logs dir resolution (ported own detect.ts semantics)
- `72b2773` feat(desktop): worker protocol types + atomic SettingsStore
- `13d1e79` feat(desktop): electron-vite scaffold with main/preload/renderer/worker entries
- `2899449` feat(parser): read-only hasOpenSegment() for shell safe-boundary checkpoints
- `861b3c1` perf(parser): cache Intl.DateTimeFormat per timezone — 23k→105k lines/sec
- `449bfad` fix(compat): exclude CI-less player units (outsider filter, adjudication #27)
- `c7f0ebb` fix(compat): drop absorb interleave from damageIn; spellSchoolId hex string (adjudications #24/#25)
- `008c95f` fix(compat): spellId/extraSpellId as strings (adjudication #23)
- `3f014fe` fix: legacy CombatantInfo shapes — talents objects, string pvpTalents, structured equipment, aurasJSON (adjudication #22)
- `b978f5e` feat: raw params passthrough on events; legacy logLine.parameters with numeric coercion (adjudication #21)
- `9d6fe40` fix(compat): advancedActions entries carry advancedActorId + logLine (adjudication #20)
- `fd29dc8` fix(compat): teamId family as strings (legacy fidelity; downstream typeof check)
- `d836ce9` feat(parser): SPELL_SUMMON owner linkage for totems/guardians (adjudication #18)
- `a53b519` feat(compat): zero effectiveAmount for pet/guardian-targeted rows (adjudication #17)
- `b578f2e` feat(compat): merge pet/guardian dmg+heal into owner arrays (adjudication #16)
- `f6f9863` fix(parser): tolerate empty elements in COMBATANT_INFO nested arrays (Blizzard quirk)
- `a90b067` fix: absorb attacker-attribution + swing-form decode + legacy effective subtracts absorbed (adjudication #13)
- `b9f6f89` fix: preserve real event names in legacy shape; SWING_DAMAGE_LANDED dedup
- `e2b7012` fix: export type for type-only re-exports (tsx ESM runtime)
- `5adf9f3` fix(parser): type-only imports for ESM strictness (tsx runtime)
- `9514711` feat(compat): legacy damage sign convention + absorb interleaving (adjudication #6)
- `f5c7940` fix(parser): segment-anchored COMBATANT_INFO decoding (2024-vintage format from diff harness)
- `1828a0c` feat(compat): WoWCombatLogParser shim covering the 7 legacy call sites
- `0381920` feat(compat): legacy types + toLegacyMatch/toLegacyShuffle converters
- `0bfc6b2` feat(compat): package skeleton + legacy enums pinned to runtime manifest
- `5372410` feat(parser): GladLogParser emits GladMatch/GladShuffle; golden fixture assertions
- `276aad7` feat(parser): l3 outcome rules + match/shuffle composer
- `2624b14` feat(parser): l3 event-collection reducers (per-unit timelines, pet attribution)
- `422390c` feat(parser): l3 flags decoder + roster builder (owner via MINE bit)
- `c0cfd03` feat(parser): l3 data model + specToClass table
- `d6b7bc0` feat(parser): GladLogParser public shell (L1+L2 wiring, stats, diagnostics)
- `eda1550` feat(parser): l2 segmenter state machine (match/shuffle/diagnostics)
- `d7e9dcc` feat(parser): snr sweep script; timestamp variants from real-log sweep (UTC-offset suffix, variable fraction width)
- `cbda5ec` feat(parser): parseLine dispatcher + public L1 surface
- `b24fce2` feat(parser): combatant_info decoder
- `b3368f5` feat(parser): l1 event-family decoders
- `86bb502` feat(parser): l1 timestamp + top-level CSV tokenizer
