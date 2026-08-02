import type { Finding } from "@gladlog/analysis";

import { buildFindingsMarkdown } from "../derive/exportReport";

interface ExportButtonsProps {
  findings: Finding[];
  heroText: string;
}

/** Findings export: the string assembly lives in derive/exportReport (covered by
 * the C3 fidelity tests) and this component only handles the clipboard. Image
 * export is not implemented (a gap noted in roadmap C3), so no fake button is
 * shown. */
export function ExportButtons({ findings, heroText }: ExportButtonsProps) {
  const handleCopyMarkdown = () => {
    void navigator.clipboard.writeText(
      buildFindingsMarkdown(findings, heroText),
    );
  };

  return (
    <div className="rpt-export-btns">
      <button className="rpt-btn" onClick={handleCopyMarkdown}>
        Copy Markdown
      </button>
    </div>
  );
}
