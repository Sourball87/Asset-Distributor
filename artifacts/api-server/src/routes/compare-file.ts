import { Router } from "express";
import { db, distributorsTable, productsTable, uploadsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import ExcelJS from "exceljs";

const router = Router();

// ─── Palette (ARGB 8-char, alpha-first) ───────────────────────
const DARK    = "FF1F2A44";
const TEAL    = "FF0E7C7B";
const GREY    = "FF6B7280";
const RED_C   = "FFC0392B";
const GREEN_C = "FF1E8449";
const AMBER_C = "FFB45309";
const INFILL  = "FFFFF7D6";
const WHITE   = "FFFFFFFF";
const IN_BORDER  = "FFD9C97A";
const BLK_BORDER = "FFC7CCD4";

const DICKER_SOH_SENTINEL = 999_999_999;

function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
function fnt(opts: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: "Arial", size: 10, ...opts };
}
function thin(argb: string): Partial<ExcelJS.Border> {
  return { style: "thin", color: { argb } };
}
// Convert 1-based column number to Excel letter(s)
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

router.get("/compare-file", requireAuth, async (req, res): Promise<void> => {
  const brandsParam      = (req.query.brands      as string | undefined) ?? "";
  const distParam        = (req.query.distributors as string | undefined) ?? "";

  const selectedBrands = brandsParam.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean);
  const selectedDistIds = distParam.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));

  // ── 1. Distributors ─────────────────────────────────────────
  const allDists   = await db.select().from(distributorsTable).orderBy(distributorsTable.id);
  const dickerDist = allDists.find((d) => d.isBaseline);
  const allCompetitors = allDists.filter((d) => !d.isBaseline);

  // Filter to selected competitors (or all if none specified)
  const competitors = selectedDistIds.length > 0
    ? allCompetitors.filter((d) => selectedDistIds.includes(d.id))
    : allCompetitors;

  // DATA sheet column layout (1-based):
  //   1=key, 2=brand, 3=desc, 4=dicker_soh, 5=dicker_price,
  //   then per competitor (3 cols each): soh, price, oo
  //   competitor i (0-based): colSoh=6+3i, colPrice=7+3i, colOo=8+3i
  interface CompetitorMeta {
    id: number;
    name: string;
    label: string;
    colSoh: number;
    colPrice: number;
    colOo: number;
  }
  const competitorMeta: CompetitorMeta[] = competitors.map((d, i) => ({
    id:       d.id,
    name:     d.name,
    label:    `▸ ${d.name}`,
    colSoh:   6 + 3 * i,
    colPrice: 7 + 3 * i,
    colOo:    8 + 3 * i,
  }));

  // ── 2. Freshness dates ───────────────────────────────────────
  type FreshnessRow = { distributor_id: number; last_date: string };
  const freshnessResult = await db.execute(sql`
    SELECT distributor_id, MAX(snapshot_date) AS last_date
    FROM uploads WHERE status = 'committed'
    GROUP BY distributor_id
  `);
  const freshnessMap = new Map<number, string>();
  for (const r of freshnessResult.rows as FreshnessRow[]) {
    freshnessMap.set(r.distributor_id, r.last_date);
  }

  // ── 3. Products ──────────────────────────────────────────────
  let products = await db
    .select()
    .from(productsTable)
    .orderBy(productsTable.brand, productsTable.vpnNormalized);
  if (selectedBrands.length > 0) {
    products = products.filter((p) => selectedBrands.includes(p.brand));
  }

  // ── 4. Latest snapshots (all distributors) ───────────────────
  type SnapRow = {
    product_id: number; distributor_id: number;
    sell_price: string | null; soh: number | null; soo: number | null;
  };
  const snapResult = await db.execute(sql`
    SELECT DISTINCT ON (product_id, distributor_id)
      product_id, distributor_id, sell_price, soh, soo
    FROM stock_snapshots
    ORDER BY product_id, distributor_id, snapshot_date DESC, id DESC
  `);
  const snapMap = new Map<string, SnapRow>();
  for (const r of snapResult.rows as SnapRow[]) {
    snapMap.set(`${r.product_id}:${r.distributor_id}`, r);
  }

  // ── 5. Build workbook ────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "DistiBench";

  const ws     = wb.addWorksheet("LOOKUP");
  const dataWs = wb.addWorksheet("DATA", { state: "veryHidden" });

  // ─── DATA sheet ────────────────────────────────────────────
  const dataHeader = [
    "key","brand","desc","dicker_soh","dicker_price",
    ...competitorMeta.flatMap((c) => [`${c.name}_soh`, `${c.name}_price`, `${c.name}_oo`]),
  ];
  dataWs.addRow(dataHeader);

  // Sort products: brand asc, dicker_soh desc (nulls last)
  const sortedProducts = [...products].sort((a, b) => {
    if (a.brand < b.brand) return -1;
    if (a.brand > b.brand) return 1;
    const aSnap = dickerDist ? snapMap.get(`${a.id}:${dickerDist.id}`) : undefined;
    const bSnap = dickerDist ? snapMap.get(`${b.id}:${dickerDist.id}`) : undefined;
    const aSOH  = (aSnap?.soh === DICKER_SOH_SENTINEL ? null : (aSnap?.soh ?? null)) ?? -1;
    const bSOH  = (bSnap?.soh === DICKER_SOH_SENTINEL ? null : (bSnap?.soh ?? null)) ?? -1;
    return bSOH - aSOH;
  });

  for (const p of sortedProducts) {
    const dkSnap  = dickerDist ? snapMap.get(`${p.id}:${dickerDist.id}`) : undefined;
    const rawSoh  = dkSnap?.soh ?? null;
    const dkSOH   = rawSoh === DICKER_SOH_SENTINEL ? null : rawSoh;
    const dkPrice = dkSnap?.sell_price != null ? parseFloat(dkSnap.sell_price) : null;

    const compCols = competitorMeta.flatMap((c) => {
      const snap = snapMap.get(`${p.id}:${c.id}`);
      return [
        snap?.soh   ?? null,
        snap?.sell_price != null ? parseFloat(snap.sell_price) : null,
        snap?.soo   ?? null,
      ];
    });

    dataWs.addRow([p.vpnNormalized, p.brand, p.description, dkSOH, dkPrice, ...compCols]);
  }

  // ─── LOOKUP sheet ──────────────────────────────────────────
  // Each block = 1 Dicker row + 1 row per selected competitor.
  // Column A (merged for full block height) = yellow empty input cell.
  // Columns B–E = side-by-side results.

  const R         = 100;
  const blockSize = 1 + competitorMeta.length; // rows per block
  const START     = 12;
  const HDR       = START - 1; // block column header = row 11
  const LAST      = START + blockSize * R - 1;

  ws.getColumn("A").width = 26;
  ws.getColumn("B").width = 56;
  ws.getColumn("C").width = 9;
  ws.getColumn("D").width = 12;
  ws.getColumn("E").width = 10;

  ws.views = [{ showGridLines: false, state: "frozen", xSplit: 0, ySplit: HDR }];

  // Row 1 — title
  ws.getRow(1).height = 30;
  ws.mergeCells("A1:E1");
  const titleCell = ws.getCell("A1");
  titleCell.value     = "DICKER DATA — PRICE & STOCK LOOKUP";
  titleCell.font      = fnt({ bold: true, size: 14, color: { argb: WHITE } });
  titleCell.fill      = solid(DARK);
  titleCell.alignment = { horizontal: "center", vertical: "middle" };

  // Row 3 — freshness panel label
  ws.mergeCells("A3:E3");
  const fpLabel = ws.getCell("A3");
  fpLabel.value = "PRICE FILE FRESHNESS — how current each distributor's feed is (upload / refresh when a feed goes stale)";
  fpLabel.font  = fnt({ bold: true, color: { argb: DARK } });

  // Row 4 — freshness column headers
  (["Distributor","Price file date","Days old","Status"] as const).forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value     = h;
    c.font      = fnt({ bold: true, size: 9, color: { argb: WHITE } });
    c.fill      = solid(GREY);
    c.alignment = { horizontal: "center", vertical: "middle" };
  });

  // Rows 5..(4+freshnessLines.length) — per-distributor freshness
  const freshnessLines = [
    { label: "Dicker Data", dist: dickerDist },
    ...competitors.map((d) => ({ label: d.name, dist: d })),
  ];
  freshnessLines.forEach(({ label, dist }, idx) => {
    const rn = 5 + idx;
    const aCell = ws.getCell(rn, 1);
    aCell.value = label;
    aCell.font  = fnt({ bold: true, color: { argb: DARK } });

    const bCell   = ws.getCell(rn, 2);
    const lastDate = dist ? freshnessMap.get(dist.id) : null;
    if (lastDate) {
      bCell.value  = new Date(lastDate + "T00:00:00");
      bCell.numFmt = "dd/mm/yyyy";
    } else {
      bCell.value = "No data";
    }

    const cCell = ws.getCell(rn, 3);
    cCell.value     = { formula: `TODAY()-B${rn}` };
    cCell.numFmt    = "0";
    cCell.alignment = { horizontal: "center" };

    const dCell = ws.getCell(rn, 4);
    dCell.value = { formula: `IF(C${rn}<=1,"current",IF(C${rn}<=3,"ageing — consider refresh","STALE — upload a new file"))` };
    dCell.font  = fnt({ bold: true });
  });

  const freshnessEnd = 4 + freshnessLines.length;
  ws.addConditionalFormatting({
    ref: `D5:D${freshnessEnd}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`$C5>3`],             style: { font: { bold: true, color: { argb: RED_C   } } } },
      { type: "expression", priority: 2, formulae: [`AND($C5>1,$C5<=3)`], style: { font: { bold: true, color: { argb: AMBER_C } } } },
      { type: "expression", priority: 3, formulae: [`$C5<=1`],            style: { font: { bold: true, color: { argb: GREEN_C } } } },
    ],
  });

  // Row 10 — instruction
  ws.mergeCells("A10:E10");
  const instrCell = ws.getCell("A10");
  instrCell.value = "Type a vendor part number in each yellow cell (column A). Stock and pricing resolve automatically to the right.";
  instrCell.font  = fnt({ italic: true, color: { argb: GREY } });

  // Row 11 — block column header
  const colHdrLabels = ["Part Number", "Description / Distributor", "SOH", "Price (ex)", "On Order"];
  colHdrLabels.forEach((h, i) => {
    const c = ws.getCell(HDR, i + 1);
    c.value     = h;
    c.font      = fnt({ bold: true, color: { argb: WHITE } });
    c.fill      = solid(DARK);
    c.alignment = { horizontal: i <= 1 ? "left" : "center", vertical: "middle", indent: i <= 1 ? 1 : 0 };
  });

  // ─── 4-row (or blockSize-row) blocks ────────────────────────
  const thinIN = thin(IN_BORDER);
  const topBlk = thin(BLK_BORDER);

  for (let k = 0; k < R; k++) {
    const base = START + blockSize * k;
    const ic   = `$A$${base}`;
    const norm = `UPPER(SUBSTITUTE(TRIM(${ic})," ",""))`;
    const mf   = `MATCH(${norm},DATA!$A:$A,0)`;

    // Merged tall input cell spanning the full block
    ws.mergeCells(base, 1, base + blockSize - 1, 1);
    const inputCell     = ws.getCell(base, 1);
    inputCell.fill      = solid(INFILL);
    inputCell.font      = fnt({ bold: true, color: { argb: DARK } });
    inputCell.alignment = { vertical: "middle", wrapText: false };
    inputCell.border    = { top: thinIN, bottom: thinIN, left: thinIN, right: thinIN };

    // Thin separator across B–E on the Dicker (top) row
    const brkBorder = { top: topBlk };
    ws.getCell(base, 2).border = brkBorder;
    ws.getCell(base, 3).border = brkBorder;
    ws.getCell(base, 4).border = brkBorder;
    ws.getCell(base, 5).border = brkBorder;

    // Dicker row
    const dkDescCol  = colLetter(3);  // C in DATA
    const dkSohCol   = colLetter(4);  // D
    const dkPriceCol = colLetter(5);  // E

    const bD = ws.getCell(base, 2);
    bD.value  = { formula: `IF(${ic}="","",IFERROR(INDEX(DATA!$${dkDescCol}:$${dkDescCol},${mf}),"— part not found —"))` };
    bD.font   = fnt({ bold: true, color: { argb: DARK } });

    const cD = ws.getCell(base, 3);
    cD.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base}),INDEX(DATA!$${dkSohCol}:$${dkSohCol},${mf}),""))` };
    cD.font      = fnt({ bold: true, color: { argb: DARK } });
    cD.alignment = { horizontal: "center" };

    const dD = ws.getCell(base, 4);
    dD.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$${dkPriceCol}:$${dkPriceCol},${mf})=0,"not stocked",INDEX(DATA!$${dkPriceCol}:$${dkPriceCol},${mf})),"not stocked"))` };
    dD.font      = fnt({ bold: true, color: { argb: DARK } });
    dD.alignment = { horizontal: "center" };
    dD.numFmt    = "$#,##0.00";

    // Competitor rows
    competitorMeta.forEach((c, ci) => {
      const row     = base + 1 + ci;
      const sohCol   = colLetter(c.colSoh);
      const priceCol = colLetter(c.colPrice);
      const ooCol    = colLetter(c.colOo);

      const bC = ws.getCell(row, 2);
      bC.value     = { formula: `IF(${ic}="","","${c.label}")` };
      bC.font      = fnt({ color: { argb: TEAL } });
      bC.alignment = { horizontal: "right" };

      const cC = ws.getCell(row, 3);
      cC.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${row}),INDEX(DATA!$${sohCol}:$${sohCol},${mf}),""))` };
      cC.alignment = { horizontal: "center" };

      const dC = ws.getCell(row, 4);
      dC.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$${priceCol}:$${priceCol},${mf})=0,"not listed",INDEX(DATA!$${priceCol}:$${priceCol},${mf})),"not listed"))` };
      dC.alignment = { horizontal: "center" };
      dC.numFmt    = "$#,##0.00";

      const eC = ws.getCell(row, 5);
      eC.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${row}),INDEX(DATA!$${ooCol}:$${ooCol},${mf}),""))` };
      eC.alignment = { horizontal: "center" };
    });
  }

  // ─── Price conditional formatting ─────────────────────────
  // Competitor rows: MOD(ROW()-START, blockSize) <> 0
  // Dicker price for block of row r: INDEX($D:$D, START + blockSize*INT((ROW()-START)/blockSize))
  if (competitorMeta.length > 0) {
    const cfRef = `D${START}:D${LAST}`;
    const dickerRef  = `${START}+${blockSize}*INT((ROW()-${START})/${blockSize})`;
    const isCompRow  = `MOD(ROW()-${START},${blockSize})<>0`;
    const dkPrice    = `INDEX($D:$D,${dickerRef})`;
    const thisPrice  = `D${START}`;
    ws.addConditionalFormatting({
      ref: cfRef,
      rules: [
        {
          type: "expression",
          priority: 1,
          formulae: [`AND(${isCompRow},ISNUMBER(${thisPrice}),ISNUMBER(${dkPrice}),${thisPrice}<${dkPrice})`],
          style: { font: { bold: true, color: { argb: RED_C   } } },
        },
        {
          type: "expression",
          priority: 2,
          formulae: [`AND(${isCompRow},ISNUMBER(${thisPrice}),ISNUMBER(${dkPrice}),${thisPrice}>${dkPrice})`],
          style: { font: { bold: true, color: { argb: GREEN_C } } },
        },
      ],
    });
  }

  // ── Stream response ──────────────────────────────────────────
  const brandLabel = selectedBrands.length > 0 ? selectedBrands.join("_") : "ALL";
  const today      = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const fname      = `Compare_${brandLabel}_${today}.xlsx`;

  res.setHeader("Content-Type",  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
