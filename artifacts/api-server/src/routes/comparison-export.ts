import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import ExcelJS from "exceljs";

const router = Router();

const DARK    = "FF1F2A44";
const TEAL    = "FF0E7C7B";
const RED_C   = "FFC0392B";
const GREEN_C = "FF1E8449";
const WHITE   = "FFFFFFFF";
const SUBHDR  = "FF374151";
const ZEBRA   = "FFF3F4F6";

function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
function fnt(opts: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: "Arial", size: 10, ...opts };
}
function mono(opts: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: "Courier New", size: 10, ...opts };
}

router.get("/comparison-export", requireAuth, async (req, res): Promise<void> => {
  const brand            = (req.query.brand  as string | undefined)?.trim().toUpperCase() || null;
  const search           = (req.query.search as string | undefined)?.trim() || null;
  const onlyMostExpensive = req.query.onlyMostExpensive === "true";
  const searchPattern    = search ? `%${search}%` : null;

  // ── 1. Query all matching rows (no pagination) ─────────────────────────────
  type QueryRow = {
    product_id:     number;
    vpn_display:    string;
    brand:          string;
    description:    string;
    distributor_data: Array<{
      distributorId:   number;
      distributorName: string;
      isBaseline:      boolean;
      sellPrice:       string | null;
      soh:             number | null;
    }>;
  };

  const { rows } = await pool.query<QueryRow>(`
    WITH
      filtered_products AS (
        SELECT p.id, p.vpn_normalized, p.vpn_display, p.brand, p.description
        FROM products p
        JOIN brands b ON b.canonical_name = p.brand AND b.reference_only = false
        WHERE ($1::text IS NULL OR p.brand = $1)
          AND ($2::text IS NULL OR (
               p.vpn_normalized ILIKE $2
            OR p.vpn_display    ILIKE $2
            OR p.description    ILIKE $2
          ))
      ),
      latest_ss AS (
        SELECT DISTINCT ON (ss.product_id, ss.distributor_id)
          ss.product_id,
          ss.distributor_id,
          ss.sell_price::numeric AS sell_price,
          ss.soh
        FROM stock_snapshots ss
        WHERE ss.product_id IN (SELECT id FROM filtered_products)
        ORDER BY ss.product_id, ss.distributor_id, ss.snapshot_date DESC, ss.id DESC
      )
    SELECT
      fp.id            AS product_id,
      fp.vpn_display,
      fp.brand,
      fp.description,
      json_agg(
        json_build_object(
          'distributorId',   d.id,
          'distributorName', d.name,
          'isBaseline',      d.is_baseline,
          'sellPrice',       l.sell_price,
          'soh',             l.soh
        ) ORDER BY d.is_baseline DESC, d.name
      ) AS distributor_data
    FROM filtered_products fp
    CROSS JOIN distributors d
    LEFT JOIN latest_ss l ON l.product_id = fp.id AND l.distributor_id = d.id
    GROUP BY fp.id, fp.vpn_normalized, fp.vpn_display, fp.brand, fp.description
    ORDER BY fp.brand, fp.vpn_normalized
  `, [brand, searchPattern]);

  // ── 2. Compute deltas, flags ───────────────────────────────────────────────
  type CompRow = {
    vpnDisplay: string;
    brand: string;
    description: string;
    dickerIsMostExpensive: boolean;
    distributors: Array<{
      distributorId:   number;
      isBaseline:      boolean;
      sellPrice:       number | null;
      soh:             number | null;
      priceDelta:      number | null;
      priceDeltaPct:   number | null;
    }>;
  };

  let compRows: CompRow[] = rows.map((row) => {
    const distData = row.distributor_data ?? [];

    let dickerPrice: number | null = null;
    for (const d of distData) {
      if (d.isBaseline && d.sellPrice != null) { dickerPrice = Number(d.sellPrice); break; }
    }

    let cheapestPrice: number | null = null;

    const distributors = distData.map((d) => {
      const sellPrice = d.sellPrice != null ? Number(d.sellPrice) : null;
      let priceDelta:    number | null = null;
      let priceDeltaPct: number | null = null;
      if (!d.isBaseline && sellPrice != null && dickerPrice != null) {
        priceDelta    = sellPrice - dickerPrice;
        priceDeltaPct = dickerPrice !== 0 ? ((sellPrice - dickerPrice) / dickerPrice) * 100 : null;
      }
      if (!d.isBaseline && sellPrice != null) {
        if (cheapestPrice == null || sellPrice < cheapestPrice) cheapestPrice = sellPrice;
      }
      return { distributorId: d.distributorId, isBaseline: d.isBaseline, sellPrice, soh: d.soh, priceDelta, priceDeltaPct };
    });

    const dickerIsMostExpensive =
      dickerPrice != null && cheapestPrice != null && dickerPrice > cheapestPrice;

    return { vpnDisplay: row.vpn_display, brand: row.brand, description: row.description, dickerIsMostExpensive, distributors };
  });

  if (onlyMostExpensive) compRows = compRows.filter((r) => r.dickerIsMostExpensive);

  // ── 3. Column layout ───────────────────────────────────────────────────────
  const distList = compRows.length > 0
    ? compRows[0].distributors
    : rows.length > 0 ? rows[0].distributor_data.map((d) => ({ distributorId: d.distributorId, isBaseline: d.isBaseline })) : [];

  type DistCols = {
    distributorId: number; distributorName: string; isBaseline: boolean;
    colStart: number; colPrice: number; colSoh: number;
    colDelta: number | null; colDeltaPct: number | null; colEnd: number;
  };

  let nextCol = 4; // cols 1-3 are VPN/Brand/Description
  const distColMap = new Map<number, DistCols>();

  for (const d of rows[0]?.distributor_data ?? []) {
    const colStart = nextCol;
    const colPrice = nextCol;
    const colSoh   = nextCol + 1;
    if (d.isBaseline) {
      distColMap.set(d.distributorId, { distributorId: d.distributorId, distributorName: d.distributorName, isBaseline: true, colStart, colPrice, colSoh, colDelta: null, colDeltaPct: null, colEnd: colSoh });
      nextCol += 2;
    } else {
      const colDelta    = nextCol + 2;
      const colDeltaPct = nextCol + 3;
      distColMap.set(d.distributorId, { distributorId: d.distributorId, distributorName: d.distributorName, isBaseline: false, colStart, colPrice, colSoh, colDelta, colDeltaPct, colEnd: colDeltaPct });
      nextCol += 4;
    }
  }
  const distCols = [...distColMap.values()];
  const COL_FLAG  = nextCol;
  const TOTAL     = COL_FLAG;

  // ── 4. Build workbook ──────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "DistiBench";
  const ws = wb.addWorksheet("COMPARISON");

  ws.views = [{ showGridLines: true, state: "frozen", xSplit: 3, ySplit: 3 }];

  // Row 1 — title
  ws.getRow(1).height = 26;
  ws.mergeCells(1, 1, 1, TOTAL);
  const today   = new Date();
  const dd      = String(today.getDate()).padStart(2, "0");
  const mm      = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy    = today.getFullYear();
  const dateStr = `${dd}.${mm}.${yyyy}`;
  const filterParts = [
    brand  ? `Brand: ${brand}`        : null,
    search ? `Search: "${search}"`    : null,
    onlyMostExpensive ? "Only where Dicker is most expensive" : null,
  ].filter(Boolean);
  const titleCell = ws.getCell(1, 1);
  titleCell.value     = `DISTRIBUTOR PRICING COMPARISON — ${dateStr}${filterParts.length ? `  ·  ${filterParts.join("  ·  ")}` : ""}`;
  titleCell.font      = fnt({ bold: true, size: 12, color: { argb: WHITE } });
  titleCell.fill      = solid(DARK);
  titleCell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };

  // Row 2 — distributor group headers
  ws.getRow(2).height = 18;
  // Blank dark fill for the three fixed left cols
  for (let c = 1; c <= 3; c++) {
    ws.getCell(2, c).fill = solid(DARK);
  }
  for (const d of distCols) {
    if (d.colStart < d.colEnd) ws.mergeCells(2, d.colStart, 2, d.colEnd);
    const cell = ws.getCell(2, d.colStart);
    cell.value     = d.isBaseline ? `${d.distributorName} ★` : d.distributorName;
    cell.font      = fnt({ bold: true, color: { argb: WHITE } });
    cell.fill      = solid(d.isBaseline ? DARK : TEAL);
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
  ws.getCell(2, COL_FLAG).fill = solid(DARK);

  // Row 3 — sub-headers
  ws.getRow(3).height = 16;
  function subHdr(col: number, label: string, align: ExcelJS.Alignment["horizontal"] = "center") {
    const c = ws.getCell(3, col);
    c.value     = label;
    c.font      = fnt({ bold: true, color: { argb: WHITE } });
    c.fill      = solid(SUBHDR);
    c.alignment = { horizontal: align, vertical: "middle", indent: align === "left" ? 1 : 0 };
  }
  subHdr(1, "VPN", "left");
  subHdr(2, "Brand", "left");
  subHdr(3, "Description", "left");
  for (const d of distCols) {
    subHdr(d.colPrice, "Price (ex)");
    subHdr(d.colSoh,   "SOH");
    if (d.colDelta    != null) subHdr(d.colDelta,    "Δ$ vs Dicker");
    if (d.colDeltaPct != null) subHdr(d.colDeltaPct, "Δ %");
  }
  subHdr(COL_FLAG, "DD ↑");

  // Column widths
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 10;
  ws.getColumn(3).width = 42;
  for (const d of distCols) {
    ws.getColumn(d.colPrice).width = 12;
    ws.getColumn(d.colSoh).width   = 8;
    if (d.colDelta    != null) ws.getColumn(d.colDelta).width    = 13;
    if (d.colDeltaPct != null) ws.getColumn(d.colDeltaPct).width = 9;
  }
  ws.getColumn(COL_FLAG).width = 6;

  // ── 5. Data rows ───────────────────────────────────────────────────────────
  compRows.forEach((row, idx) => {
    const r      = idx + 4;
    const isOdd  = idx % 2 === 1;
    const bg     = isOdd ? ZEBRA : WHITE;
    const flagBg = row.dickerIsMostExpensive ? "FFFFF1F2" : bg;

    const setBase = (col: number, value: ExcelJS.CellValue, font: Partial<ExcelJS.Font>, bg2 = bg, align: Partial<ExcelJS.Alignment> = { vertical: "middle" }) => {
      const c = ws.getCell(r, col);
      c.value     = value;
      c.font      = font;
      c.fill      = solid(bg2);
      c.alignment = align;
    };

    setBase(1, row.vpnDisplay, mono({ color: { argb: DARK } }), bg, { vertical: "middle", indent: 1 });
    setBase(2, row.brand,       fnt({ bold: true, color: { argb: DARK } }), bg, { vertical: "middle", indent: 1 });
    setBase(3, row.description, fnt({ color: { argb: "FF6B7280" } }), bg, { vertical: "middle", indent: 1 });

    for (const dc of distCols) {
      const entry = row.distributors.find((x) => x.distributorId === dc.distributorId);
      const price = entry?.sellPrice ?? null;
      const soh   = entry?.soh      ?? null;

      const priceCell = ws.getCell(r, dc.colPrice);
      priceCell.value     = price;
      priceCell.numFmt    = "$#,##0.00";
      priceCell.font      = dc.isBaseline ? fnt({ bold: true, color: { argb: DARK } }) : fnt({ color: { argb: DARK } });
      priceCell.fill      = solid(bg);
      priceCell.alignment = { horizontal: "right", vertical: "middle" };

      const sohCell = ws.getCell(r, dc.colSoh);
      sohCell.value     = soh;
      sohCell.numFmt    = "#,##0";
      sohCell.font      = fnt({ color: { argb: DARK } });
      sohCell.fill      = solid(bg);
      sohCell.alignment = { horizontal: "right", vertical: "middle" };

      if (!dc.isBaseline && dc.colDelta != null && dc.colDeltaPct != null) {
        const delta    = entry?.priceDelta    ?? null;
        const deltaPct = entry?.priceDeltaPct ?? null;
        const dColor   = delta == null ? DARK : delta < 0 ? RED_C : GREEN_C;

        const deltaCell = ws.getCell(r, dc.colDelta);
        deltaCell.value     = delta;
        deltaCell.numFmt    = "$#,##0.00";
        deltaCell.font      = fnt({ bold: true, color: { argb: dColor } });
        deltaCell.fill      = solid(bg);
        deltaCell.alignment = { horizontal: "right", vertical: "middle" };

        const dPctCell = ws.getCell(r, dc.colDeltaPct);
        dPctCell.value     = deltaPct != null ? deltaPct / 100 : null;
        dPctCell.numFmt    = "+0.0%;-0.0%;";
        dPctCell.font      = fnt({ color: { argb: dColor } });
        dPctCell.fill      = solid(bg);
        dPctCell.alignment = { horizontal: "right", vertical: "middle" };
      }
    }

    const flagCell = ws.getCell(r, COL_FLAG);
    flagCell.value     = row.dickerIsMostExpensive ? "⚑" : "";
    flagCell.font      = fnt({ bold: true, color: { argb: RED_C } });
    flagCell.fill      = solid(flagBg);
    flagCell.alignment = { horizontal: "center", vertical: "middle" };
  });

  // ── 6. Stream ──────────────────────────────────────────────────────────────
  const slug    = `${yyyy}${mm}${dd}`;
  const fname   = `Comparison_${slug}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
