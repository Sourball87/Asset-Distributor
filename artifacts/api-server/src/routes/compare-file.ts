import { Router } from "express";
import { db, distributorsTable, productsTable, stockSnapshotsTable, uploadsTable } from "@workspace/db";
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

router.get("/compare-file", requireAuth, async (req, res): Promise<void> => {
  const brandsParam = (req.query.brands as string | undefined) ?? "";
  const selectedBrands = brandsParam
    .split(",")
    .map((b) => b.trim().toUpperCase())
    .filter(Boolean);

  // ── 1. Distributors ─────────────────────────────────────────
  const distributors = await db.select().from(distributorsTable).orderBy(distributorsTable.id);
  const dickerDist = distributors.find((d) => d.isBaseline);
  const ingramDist = distributors.find((d) => d.name.toLowerCase().includes("ingram"));
  const synnexDist = distributors.find((d) => d.name.toLowerCase().includes("synnex"));
  const leaderDist = distributors.find((d) => d.name.toLowerCase().includes("leader"));

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

  // ── 4. Latest snapshots (DISTINCT ON) ───────────────────────
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

  // ── 5. Build data rows ───────────────────────────────────────
  interface DataRow {
    key: string; brand: string; desc: string;
    dicker_soh: number | null; dicker_price: number | null;
    ingram_soh: number | null; ingram_price: number | null; ingram_oo: number | null;
    synnex_soh: number | null; synnex_price: number | null;
    leader_soh: number | null; leader_price: number | null;
  }

  const dataRows: DataRow[] = products.map((p) => {
    const dkSnap = dickerDist ? snapMap.get(`${p.id}:${dickerDist.id}`) : undefined;
    const igSnap = ingramDist ? snapMap.get(`${p.id}:${ingramDist.id}`) : undefined;
    const sxSnap = synnexDist ? snapMap.get(`${p.id}:${synnexDist.id}`) : undefined;
    const ldSnap = leaderDist ? snapMap.get(`${p.id}:${leaderDist.id}`) : undefined;

    const rawSoh = dkSnap?.soh ?? null;
    const dickerSoh = rawSoh === DICKER_SOH_SENTINEL ? null : rawSoh;

    return {
      key:          p.vpnNormalized,
      brand:        p.brand,
      desc:         p.description,
      dicker_soh:   dickerSoh,
      dicker_price: dkSnap?.sell_price != null ? parseFloat(dkSnap.sell_price) : null,
      ingram_soh:   igSnap?.soh ?? null,
      ingram_price: igSnap?.sell_price != null ? parseFloat(igSnap.sell_price) : null,
      ingram_oo:    igSnap?.soo ?? null,
      synnex_soh:   sxSnap?.soh ?? null,
      synnex_price: sxSnap?.sell_price != null ? parseFloat(sxSnap.sell_price) : null,
      leader_soh:   ldSnap?.soh ?? null,
      leader_price: ldSnap?.sell_price != null ? parseFloat(ldSnap.sell_price) : null,
    };
  });

  // Sort: brand asc, dicker_soh desc (nulls last)
  dataRows.sort((a, b) => {
    if (a.brand < b.brand) return -1;
    if (a.brand > b.brand) return 1;
    return (b.dicker_soh ?? -1) - (a.dicker_soh ?? -1);
  });

  // ── 6. Build workbook ────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "DistiBench";

  // Add LOOKUP first so it opens as the active sheet
  const ws     = wb.addWorksheet("LOOKUP");
  const dataWs = wb.addWorksheet("DATA", { state: "veryHidden" });

  // ─── DATA sheet ────────────────────────────────────────────
  dataWs.addRow(["key","brand","desc","dicker_soh","dicker_price","ingram_soh","ingram_price","ingram_oo","synnex_soh","synnex_price","leader_soh","leader_price"]);
  for (const r of dataRows) {
    dataWs.addRow([
      r.key, r.brand, r.desc,
      r.dicker_soh, r.dicker_price,
      r.ingram_soh, r.ingram_price, r.ingram_oo,
      r.synnex_soh, r.synnex_price,
      r.leader_soh, r.leader_price,
    ]);
  }

  // ─── LOOKUP sheet ──────────────────────────────────────────
  // New layout: each block is 4 rows tall.
  // Col A (merged, tall) = yellow input cell where user types the VPN.
  // Cols B-E = Dicker + competitor rows side-by-side within those 4 rows.
  // No separate input list or results section — everything is in-line.

  const R     = 50;          // number of lookup blocks
  const START = 12;          // first block starts at row 12
  const HDR   = START - 1;  // column header row = 11
  const LAST  = START + 4 * R - 1;

  // Column widths (per spec)
  ws.getColumn("A").width = 26;
  ws.getColumn("B").width = 56;
  ws.getColumn("C").width = 9;
  ws.getColumn("D").width = 12;
  ws.getColumn("E").width = 10;

  // Freeze rows 1–11 (freshness strip + block header stay visible while scrolling)
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

  // Rows 5–8 — per-distributor freshness data
  const freshnessLines = [
    { label: "Dicker Data", dist: dickerDist },
    { label: "Ingram",      dist: ingramDist },
    { label: "Synnex",      dist: synnexDist },
    { label: "Leader",      dist: leaderDist },
  ];
  freshnessLines.forEach(({ label, dist }, idx) => {
    const rn = 5 + idx;
    const aCell = ws.getCell(rn, 1);
    aCell.value = label;
    aCell.font  = fnt({ bold: true, color: { argb: DARK } });

    const bCell = ws.getCell(rn, 2);
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

  // Conditional formatting — freshness status
  ws.addConditionalFormatting({
    ref: "D5:D8",
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

  // ─── 4-row blocks ──────────────────────────────────────────
  // Block k (0-based): base = START + 4*k
  //   A{base}:A{base+3} — merged, yellow, user types VPN here
  //   B{base}  / C{base}  / D{base}          — Dicker row (description / SOH / price)
  //   B{base+1}/ C{base+1}/ D{base+1}/ E{base+1} — Ingram  row
  //   B{base+2}/ C{base+2}/ D{base+2}        — Synnex  row
  //   B{base+3}/ C{base+3}/ D{base+3}        — Leader  row
  //   Thin BLK_BORDER top border across A–E on the Dicker row.

  const thinIN  = thin(IN_BORDER);
  const topBlk  = thin(BLK_BORDER);

  for (let k = 0; k < R; k++) {
    const base  = START + 4 * k;
    const ic    = `$A$${base}`;   // absolute ref to the merged input cell
    const norm  = `UPPER(SUBSTITUTE(TRIM(${ic})," ",""))`;
    const mf    = `MATCH(${norm},DATA!$A:$A,0)`;

    // Merge A{base}:A{base+3} — tall yellow input cell
    ws.mergeCells(base, 1, base + 3, 1);
    const inputCell      = ws.getCell(base, 1);
    inputCell.fill       = solid(INFILL);
    inputCell.font       = fnt({ bold: true, color: { argb: DARK } });
    inputCell.alignment  = { vertical: "middle", wrapText: false };
    inputCell.border     = { top: thinIN, bottom: thinIN, left: thinIN, right: thinIN };

    // Top separator border on entire Dicker row
    const brkBorder = { top: topBlk };
    ws.getCell(base, 2).border = brkBorder;
    ws.getCell(base, 3).border = brkBorder;
    ws.getCell(base, 4).border = brkBorder;
    ws.getCell(base, 5).border = brkBorder;

    // Dicker row — B, C, D (row = base)
    const bD = ws.getCell(base, 2);
    bD.value  = { formula: `IF(${ic}="","",IFERROR(INDEX(DATA!$C:$C,${mf}),"— part not found —"))` };
    bD.font   = fnt({ bold: true, color: { argb: DARK } });

    const cD = ws.getCell(base, 3);
    cD.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base}),INDEX(DATA!$D:$D,${mf}),""))` };
    cD.font      = fnt({ bold: true, color: { argb: DARK } });
    cD.alignment = { horizontal: "center" };

    const dD = ws.getCell(base, 4);
    dD.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$E:$E,${mf})=0,"not stocked",INDEX(DATA!$E:$E,${mf})),"not stocked"))` };
    dD.font      = fnt({ bold: true, color: { argb: DARK } });
    dD.alignment = { horizontal: "center" };
    dD.numFmt    = "$#,##0.00";

    // Ingram row — B, C, D, E (row = base+1)
    const bI = ws.getCell(base + 1, 2);
    bI.value     = { formula: `IF(${ic}="","","▸ Ingram")` };
    bI.font      = fnt({ color: { argb: TEAL } });
    bI.alignment = { horizontal: "right" };

    const cI = ws.getCell(base + 1, 3);
    cI.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base + 1}),INDEX(DATA!$F:$F,${mf}),""))` };
    cI.alignment = { horizontal: "center" };

    const dI = ws.getCell(base + 1, 4);
    dI.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$G:$G,${mf})=0,"not listed",INDEX(DATA!$G:$G,${mf})),"not listed"))` };
    dI.alignment = { horizontal: "center" };
    dI.numFmt    = "$#,##0.00";

    const eI = ws.getCell(base + 1, 5);
    eI.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base + 1}),INDEX(DATA!$H:$H,${mf}),""))` };
    eI.alignment = { horizontal: "center" };

    // Synnex row — B, C, D (row = base+2)
    const bS = ws.getCell(base + 2, 2);
    bS.value     = { formula: `IF(${ic}="","","▸ Synnex")` };
    bS.font      = fnt({ color: { argb: TEAL } });
    bS.alignment = { horizontal: "right" };

    const cS = ws.getCell(base + 2, 3);
    cS.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base + 2}),INDEX(DATA!$I:$I,${mf}),""))` };
    cS.alignment = { horizontal: "center" };

    const dS = ws.getCell(base + 2, 4);
    dS.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$J:$J,${mf})=0,"not listed",INDEX(DATA!$J:$J,${mf})),"not listed"))` };
    dS.alignment = { horizontal: "center" };
    dS.numFmt    = "$#,##0.00";

    // Leader row — B, C, D (row = base+3)
    const bL = ws.getCell(base + 3, 2);
    bL.value     = { formula: `IF(${ic}="","","▸ Leader")` };
    bL.font      = fnt({ color: { argb: TEAL } });
    bL.alignment = { horizontal: "right" };

    const cL = ws.getCell(base + 3, 3);
    cL.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base + 3}),INDEX(DATA!$K:$K,${mf}),""))` };
    cL.alignment = { horizontal: "center" };

    const dL = ws.getCell(base + 3, 4);
    dL.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$L:$L,${mf})=0,"not listed",INDEX(DATA!$L:$L,${mf})),"not listed"))` };
    dL.alignment = { horizontal: "center" };
    dL.numFmt    = "$#,##0.00";
  }

  // ─── Price conditional formatting ─────────────────────────
  // Applied over D{START}:D{LAST}.
  // For each row r, the Dicker price for its block is at D{START + 4*INT((r-START)/4)}.
  // Competitor rows satisfy MOD(r-START,4) <> 0.
  // Red  = competitor D < Dicker D (Dicker dearer)
  // Green = competitor D > Dicker D (Dicker competitive)
  const cfRef = `D${START}:D${LAST}`;
  ws.addConditionalFormatting({
    ref: cfRef,
    rules: [
      {
        type: "expression",
        priority: 1,
        formulae: [`AND(MOD(ROW()-${START},4)<>0,ISNUMBER(D${START}),ISNUMBER(INDEX($D:$D,${START}+4*INT((ROW()-${START})/4))),D${START}<INDEX($D:$D,${START}+4*INT((ROW()-${START})/4)))`],
        style: { font: { bold: true, color: { argb: RED_C   } } },
      },
      {
        type: "expression",
        priority: 2,
        formulae: [`AND(MOD(ROW()-${START},4)<>0,ISNUMBER(D${START}),ISNUMBER(INDEX($D:$D,${START}+4*INT((ROW()-${START})/4))),D${START}>INDEX($D:$D,${START}+4*INT((ROW()-${START})/4)))`],
        style: { font: { bold: true, color: { argb: GREEN_C } } },
      },
    ],
  });

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
