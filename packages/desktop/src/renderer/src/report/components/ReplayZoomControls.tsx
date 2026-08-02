/**
 * Zoom overlay in the bottom-right corner of the map. The class names are a
 * contract with report.replayzoom.test.tsx — do not rename them.
 */
export function ReplayZoomControls(props: {
  zoomLevel: number | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <span className="rpt-replay-zoom-group">
      <button
        className="rpt-replay-zoom-btn"
        title="放大(也可 ⌘/Ctrl+滚轮;放大后普通滚轮即可继续缩放,拖拽平移)"
        onClick={props.onZoomIn}
      >
        +
      </button>
      <button
        className="rpt-replay-zoom-btn"
        title="缩小"
        onClick={props.onZoomOut}
      >
        −
      </button>
      {props.zoomLevel != null && (
        <button
          className="rpt-replay-zoom-reset"
          title="复位缩放(或双击地图)"
          onClick={props.onReset}
        >
          ⤢ {props.zoomLevel}× 复位
        </button>
      )}
    </span>
  );
}
