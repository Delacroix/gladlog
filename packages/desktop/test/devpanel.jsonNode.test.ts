import {
  ancestorPaths,
  ARRAY_PAGE_SIZE,
  childrenOf,
  kindOf,
  leafPreview,
  resolvePath,
  SEARCH_NODE_BUDGET,
  searchKeyPaths,
} from "../src/renderer/src/components/dev/jsonNode";

/**
 * 检查器的性能契约(方案 5a 三点七 验收①):树只序列化**展开的节点**。
 * 旧实现把整份 doc(库内均值 ≈62MB)一次 stringify 后灌 <pre>,渲染进程冻死;
 * 这里的断言是「没展开的容器,其元素一次都不被读到」——不是耗时断言(会抖),
 * 是访问计数断言(确定性)。
 */
describe("jsonNode:懒展开", () => {
  it("列子节点时不读未展开容器的元素", () => {
    let elementReads = 0;
    const big = new Proxy(
      Array.from({ length: 1000 }, (_, i) => ({ i })),
      {
        get(t, p, r) {
          if (typeof p === "string" && /^\d+$/.test(p)) elementReads++;
          return Reflect.get(t, p, r);
        },
      },
    );

    const { children } = childrenOf({ rounds: big, kind: "shuffle" }, "", 0);

    const rounds = children.find((c) => c.key === "rounds")!;
    expect(rounds.kind).toBe("array");
    expect(rounds.summary).toBe("[1000]");
    expect(rounds.preview).toBeNull();
    expect(elementReads).toBe(0);
  });

  it("叶子给行内预览,容器给规模摘要", () => {
    const { children } = childrenOf(
      {
        name: "PlayerA-Test",
        hp: 42,
        dead: false,
        gone: null,
        units: { a: 1 },
      },
      "",
      0,
    );
    const byKey = Object.fromEntries(children.map((c) => [c.key, c]));
    expect(byKey["name"]!.preview).toBe('"PlayerA-Test"');
    expect(byKey["hp"]!.preview).toBe("42");
    expect(byKey["dead"]!.preview).toBe("false");
    expect(byKey["gone"]!.preview).toBe("null");
    expect(byKey["units"]!.preview).toBeNull();
    expect(byKey["units"]!.summary).toBe("{1}");
  });

  it("子节点 path 用 obj.key / arr[i] 记法,可回喂 resolvePath", () => {
    const doc = { rounds: [{ deaths: ["x"] }] };
    const lvl1 = childrenOf(doc, "", 0).children;
    expect(lvl1[0]!.path).toBe("rounds");
    const lvl2 = childrenOf(lvl1[0]!.value, "rounds", 0).children;
    expect(lvl2[0]!.path).toBe("rounds[0]");
    const lvl3 = childrenOf(lvl2[0]!.value, "rounds[0]", 0).children;
    expect(lvl3[0]!.path).toBe("rounds[0].deaths");
    expect(resolvePath(doc, "rounds[0].deaths").value).toEqual(["x"]);
  });
});

describe("jsonNode:大数组分页", () => {
  const arr = Array.from({ length: 1234 }, (_, i) => i);

  it("每页 500 条,尾页只给余数", () => {
    const p0 = childrenOf(arr, "casts", 0);
    expect(ARRAY_PAGE_SIZE).toBe(500);
    expect(p0.children).toHaveLength(500);
    expect(p0.total).toBe(1234);
    expect(p0.pages).toBe(3);
    expect(p0.children[0]!.path).toBe("casts[0]");

    const p2 = childrenOf(arr, "casts", 2);
    expect(p2.children).toHaveLength(234);
    expect(p2.children[0]!.path).toBe("casts[1000]");
  });

  it("越界页码回落到最后一页,不返回空列表", () => {
    const p = childrenOf(arr, "casts", 99);
    expect(p.children).toHaveLength(234);
    expect(p.children[0]!.path).toBe("casts[1000]");
  });

  it("对象不分页(键数远小于数组,分页只会碍事)", () => {
    const obj = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [`u${i}`, i]),
    );
    const p = childrenOf(obj, "units", 0);
    expect(p.children).toHaveLength(700);
    expect(p.pages).toBe(1);
  });
});

describe("jsonNode:叶子预览封顶", () => {
  it("超长字符串截断并标注原长,不把整段塞进 DOM", () => {
    const long = "x".repeat(50_000);
    const preview = leafPreview(long);
    expect(preview.length).toBeLessThan(300);
    expect(preview).toContain("50000");
  });

  it("短值原样 JSON 记法", () => {
    expect(leafPreview("hi")).toBe('"hi"');
    expect(leafPreview(3.5)).toBe("3.5");
  });
});

describe("jsonNode:路径解析与祖先展开", () => {
  const doc = { rounds: [{ deaths: [{ unit: "A" }] }, { deaths: [] }] };

  it("解析出存在的路径", () => {
    expect(resolvePath(doc, "rounds[0].deaths[0].unit")).toEqual({
      ok: true,
      value: "A",
    });
  });

  it("不存在的键/越界下标 → ok:false", () => {
    expect(resolvePath(doc, "rounds[9].deaths").ok).toBe(false);
    expect(resolvePath(doc, "rounds[0].nope").ok).toBe(false);
  });

  it("空路径 = 根", () => {
    expect(resolvePath(doc, "")).toEqual({ ok: true, value: doc });
  });

  it("祖先路径按序给出,供命中后逐级展开", () => {
    expect(ancestorPaths("rounds[0].deaths[0].unit")).toEqual([
      "rounds",
      "rounds[0]",
      "rounds[0].deaths",
      "rounds[0].deaths[0]",
    ]);
    expect(ancestorPaths("rounds")).toEqual([]);
  });
});

describe("jsonNode:键名搜索有节点预算", () => {
  it("命中键名并返回完整路径", () => {
    const doc = { units: { a: { casts: [1] } }, rounds: [{ casts: [] }] };
    expect(searchKeyPaths(doc, "casts").paths).toEqual([
      "units.a.casts",
      "rounds[0].casts",
    ]);
  });

  it("超出节点预算时停止扫描并标注截断 —— 主线程不能被 62MB 全图遍历占死", () => {
    const wide = Object.fromEntries(
      Array.from({ length: SEARCH_NODE_BUDGET + 5000 }, (_, i) => [`k${i}`, i]),
    );
    const r = searchKeyPaths(wide, "k1");
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBeLessThanOrEqual(SEARCH_NODE_BUDGET);
  });

  it("命中数也封顶,避免一次高亮上万行", () => {
    const doc = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`casts${i}`, i]),
    );
    expect(searchKeyPaths(doc, "casts").paths.length).toBeLessThanOrEqual(50);
  });
});

describe("jsonNode:kindOf", () => {
  it("区分数组与对象(JSON 树的展开判据)", () => {
    expect(kindOf([])).toBe("array");
    expect(kindOf({})).toBe("object");
    expect(kindOf(null)).toBe("null");
    expect(kindOf("s")).toBe("string");
    expect(kindOf(1)).toBe("number");
    expect(kindOf(true)).toBe("boolean");
  });
});
