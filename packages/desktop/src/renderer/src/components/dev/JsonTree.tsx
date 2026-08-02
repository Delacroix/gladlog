import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  ARRAY_PAGE_SIZE,
  childrenOf,
  isContainer,
  type JsonChild,
} from "./jsonNode";

/**
 * 懒展开 JSON 树。**只有展开的节点才进 DOM** —— 见 jsonNode.ts 的说明,
 * 这是本组件存在的唯一理由(旧实现整份 stringify 灌 <pre>,渲染进程冻死)。
 */
export interface JsonTreeProps {
  root: unknown;
  /** 当前选中(右栏「复制当前节点」的对象) */
  selectedPath: string;
  onSelect(path: string, value: unknown): void;
  /** 搜索命中的路径:高亮 */
  hits?: readonly string[];
  /** 外部要求展开到的路径(搜索命中的祖先链);变化时并入已展开集合 */
  autoExpand?: readonly string[];
}

export function JsonTree({
  root,
  selectedPath,
  onSelect,
  hits,
  autoExpand,
}: JsonTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>(),
  );

  // 换了对局:折叠状态与页码全部重置,否则上一场的路径会挂在新文档上
  useEffect(() => {
    setExpanded(new Set<string>());
    setPages(new Map<string, number>());
  }, [root]);

  useEffect(() => {
    if (!autoExpand || autoExpand.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of autoExpand) next.add(p);
      return next;
    });
  }, [autoExpand]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const setPage = useCallback((path: string, page: number) => {
    setPages((prev) => new Map(prev).set(path, page));
  }, []);

  const hitSet = useMemo(() => new Set(hits ?? []), [hits]);

  return (
    <div className="dev-json-tree" data-testid="dev-json-tree">
      <Rows
        value={root}
        basePath=""
        depth={0}
        expanded={expanded}
        toggle={toggle}
        pages={pages}
        setPage={setPage}
        hits={hitSet}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    </div>
  );
}

interface RowsProps {
  value: unknown;
  basePath: string;
  depth: number;
  expanded: ReadonlySet<string>;
  toggle(path: string): void;
  pages: ReadonlyMap<string, number>;
  setPage(path: string, page: number): void;
  hits: ReadonlySet<string>;
  selectedPath: string;
  onSelect(path: string, value: unknown): void;
}

function Rows(props: RowsProps) {
  const { value, basePath, depth, expanded, pages } = props;
  const page = childrenOf(value, basePath, pages.get(basePath) ?? 0);

  return (
    <>
      {page.pages > 1 && (
        <PageBar
          depth={depth}
          total={page.total}
          page={page.page}
          pages={page.pages}
          onGo={(p) => props.setPage(basePath, p)}
        />
      )}
      {page.children.map((c) => (
        <Fragment key={c.path}>
          <Row {...props} child={c} />
          {expanded.has(c.path) && isContainer(c.kind) && (
            <Rows
              {...props}
              value={c.value}
              basePath={c.path}
              depth={depth + 1}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}

function Row({
  child,
  depth,
  expanded,
  toggle,
  hits,
  selectedPath,
  onSelect,
}: RowsProps & { child: JsonChild }) {
  const container = isContainer(child.kind);
  const open = expanded.has(child.path);
  const cls = [
    "dev-node",
    `k-${child.kind}`,
    selectedPath === child.path ? "sel" : "",
    hits.has(child.path) ? "hit" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 展开与选中是两个并列的 <button>,不是「div onClick 里套 button」——
  // 后者既不可键盘操作,嵌套按钮也是非法 HTML(axe 会在 dev 场景打红)。
  return (
    <div
      className={cls}
      data-node-path={child.path}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      {container ? (
        <button
          type="button"
          className="dev-node-toggle"
          aria-expanded={open}
          aria-label={`${open ? "折叠" : "展开"} ${child.path}`}
          onClick={() => toggle(child.path)}
        >
          {open ? "▾" : "▸"}
        </button>
      ) : (
        <span className="dev-node-toggle ph" aria-hidden="true" />
      )}
      <button
        type="button"
        className="dev-node-key"
        onClick={() => onSelect(child.path, child.value)}
      >
        {child.key}
      </button>
      {child.summary !== null ? (
        <span className="dev-node-sum">{child.summary}</span>
      ) : (
        <span className="dev-node-val">{child.preview}</span>
      )}
    </div>
  );
}

function PageBar({
  depth,
  total,
  page,
  pages,
  onGo,
}: {
  depth: number;
  total: number;
  page: number;
  pages: number;
  onGo(p: number): void;
}) {
  const from = page * ARRAY_PAGE_SIZE;
  const to = Math.min(total, from + ARRAY_PAGE_SIZE);
  return (
    <div
      className="dev-node-pager"
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
      data-testid="dev-node-pager"
    >
      <button
        type="button"
        disabled={page === 0}
        onClick={() => onGo(page - 1)}
      >
        ‹
      </button>
      <span>
        {from}–{to - 1} / {total}
      </span>
      <button
        type="button"
        disabled={page >= pages - 1}
        onClick={() => onGo(page + 1)}
      >
        ›
      </button>
    </div>
  );
}
