# 录像 tab 关键信息关联(标记条 + 事件 feed)实施计划

2026-07-29,用户拍板 brainstorm 方案 A+C:A=视频下方对齐标记条;C=**视频右侧
独立一栏**的播放事件 feed(用户明确:不叠在画面右上)。行为:播放越过事件
时刻从底部滑入、旧条目到时淡出、下面往上顶(kill-feed 式)。分支
`feature/obs-recording`,验收出 v0.1.14-obs.6 测试包。

## 设计要点(brainstorm 定稿)

- **数据单源**:新 derive `videoMoments.ts` 合并三路——`deriveKeyMoments`
  (死亡/爆发带/防御/驱散/控制,相对秒)+ `deriveMistakes`(⚠ 8 类)+
  AI 深挖 chips(`analysis.getCached(matchId)` 的 `findings[].deepDive.chips`,
  `t` 已是相对秒)。统一为
  `VideoMoment {tS, toS?, kind, weight, label, unitNames}`。
- **A 标记条**:等宽对齐视频进度;背景铺 burst-band 金带,✕ 死亡(红)、
  ⚠ 失误(金)点标;hover title、点击 `video.currentTime = tS + offset`。
  只画 major + mistakes,minor 不进条(防密)。
- **C feed**:右侧 ~280px 列。核心是**纯函数 reducer**(可测):
  `advanceFeed(state, nowS, wallNow, moments)` —— 正常推进收 `(lastS, nowS]`
  的 moments;时间跳变(回退或前跳 >3s)重置为 `(nowS-5, nowS]`;墙钟 TTL
  5s 过期(先标 `out` 播 400ms 淡出动画再移除);同屏 cap 4,超出丢最旧。
  驱动 = video `timeupdate`(~4Hz),不碰回放页时钟。开关按钮 + localStorage
  记忆。
- **换算**:`videoS = tS + (source.startTime - startedAt)/1000`;strip 百分比
  用 video.duration(loadedmetadata 后)。
- **AI chips 获取**:VideoTab 新增 `matchId` prop(MatchReport 传
  `resolvedMatchId` —— shuffle 每轮的分析缓存本就按轮,chips 相对秒也按轮,
  与录像 videoMatchId 是两条正交的 id,别混)。
- 已知边界:原生全屏全屏的是 video 元素,feed/strip 不可见——一期接受。

## 任务

1. `derive/videoMoments.ts` + 测试:fixture 上合并三路、按 tS 排序、label 非空;
   AI chips 注入路径用假 chips。
2. `components/VideoFeed.tsx`:导出纯 `advanceFeed` + 组件;reducer 单测覆盖
   推进/跳变重置/TTL/cap。
3. `components/VideoMomentStrip.tsx`:纯展示 + onSeek;测试:major 数量渲染
   与点击回调。
4. `VideoTab.tsx` 接线:flex 布局(video 主体 + 右栏)、timeupdate → battleS、
   strip/feed 挂载、AI chips 拉取(try/catch 缺面降级)、开关;
   MatchReport 传 matchId。既有 VideoTab 测试更新。
5. presubmit → commit → v0.1.14-obs.6 → 真机验收(strip 点击跟手、feed 滑入/
   淡出/上顶、拖进度条不弹历史)。
