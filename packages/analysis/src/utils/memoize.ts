/** 按第一个参数缓存(Map 的 SameValueZero 语义,等价 lodash MapCache)——
 * 整包原本只为 4 个函数拖 215KB CJS lodash,此为其中 memoize 的替身。
 *
 * 带就绪门:数据表是后台加载的(见 data/spellEffectData.ts 的设计说明),
 * 加载完成前的调用只能算出空表降级结果 —— 这种结果**只算不缓存**,否则
 * 一旦被缓存,加载完成后也永远拿不到真值(memoize 卡死空结果)。 */
export function memoizeWhenReady<A, R>(
  isReady: () => boolean,
  fn: (arg: A) => R,
): (arg: A) => R {
  const cache = new Map<A, R>();
  return (arg: A) => {
    if (!isReady()) return fn(arg);
    if (cache.has(arg)) return cache.get(arg)!;
    const r = fn(arg);
    cache.set(arg, r);
    return r;
  };
}
