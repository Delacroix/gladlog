/**
 * Pure黑帧判定(design doc §7.1-7.2 / task-4 brief 规则 8):没有钩上游戏画面时,
 * OBS 截图源近乎全黑而不是报错——从产品角度这是"完全无声的失败",必须靠像素内容
 * 自己判断,不能指望 websocket 给出一个明确的错误。
 *
 * 纯函数,不碰文件/网络:调用方(managedObsBackend.captureProbe)负责把
 * SaveSourceScreenshot 落盘的图片解码成逐像素亮度数组喂进来。阈值和判定逻辑单独
 * 拆出来是为了可测——喂固定数组就能覆盖全黑/正常/暗场三类,不用真解码一张图片。
 */

/** 平均亮度阈值(0-255 尺度):低于此值才可能是黑帧。 */
export const MEAN_LUMINANCE_THRESHOLD = 8;

/** 单像素“亮”的判定线——用来在近乎全黑的画面里挑出零星高亮像素(比如角落里一小块
 * 没被裁掉的 UI/字幕)。设计文档只给了“高亮像素占比”这个统计量的阈值,没规定单像素
 * 层面多亮算“亮”;这个值是实现者按经验选的(远高于 MEAN_LUMINANCE_THRESHOLD,又不
 * 至于把普通暗场里的中等亮度像素都算进来),没有源码级引用可查——如果真机误判,先调
 * 这个常量。 */
export const BRIGHT_PIXEL_LUMINANCE_THRESHOLD = 32;

/** 高亮像素占比阈值:低于此值(且均值也低于阈值)才判黑帧。 */
export const BRIGHT_RATIO_THRESHOLD = 0.005;

export interface BlackFrameJudgment {
  black: boolean;
  meanLuminance: number;
  brightRatio: number;
}

/**
 * 输入:逐像素亮度(0-255,取值范围不做校验——调用方保证)。空输入视为黑帧(拿不到
 * 信号是最坏情况,不能悄悄当作"画面正常"处理,那样会把"根本没截到图"和"截到了但
 * 是黑的"混为一谈,两者对用户的可见后果不同但对 sourceActive 这个布尔值而言,宁可
 * 保守报"没钩上")。
 *
 * 判黑帧 = 平均亮度 < MEAN_LUMINANCE_THRESHOLD **且** 高亮像素占比 <
 * BRIGHT_RATIO_THRESHOLD(两个条件都是严格小于——正好卡在阈值上判"不是黑帧",宁可
 * 偏向"还有画面"这一侧,避免真实暗场对局被误报成掉线)。
 */
export function judgeBlackFrame(
  luminances: ArrayLike<number>,
): BlackFrameJudgment {
  const n = luminances.length;
  if (n === 0) {
    return { black: true, meanLuminance: 0, brightRatio: 0 };
  }
  let sum = 0;
  let brightCount = 0;
  for (let i = 0; i < n; i++) {
    const l = luminances[i]!;
    sum += l;
    if (l > BRIGHT_PIXEL_LUMINANCE_THRESHOLD) brightCount++;
  }
  const meanLuminance = sum / n;
  const brightRatio = brightCount / n;
  const black =
    meanLuminance < MEAN_LUMINANCE_THRESHOLD &&
    brightRatio < BRIGHT_RATIO_THRESHOLD;
  return { black, meanLuminance, brightRatio };
}
