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
  const R = 50; // fixed input slots — user pastes their own SKUs
  const IN_START    = 12;
  const IN_END      = 11 + R;
  const RESULTS_ROW = IN_END + 2;
  const COL_HDR_ROW = IN_END + 3;
  const OUT0        = IN_END + 4;

  ws.views = [{ showGridLines: false, state: "frozen", xSplit: 0, ySplit: 11 }];
  ws.getColumn("A").width = 34;
  ws.getColumn("B").width = 60;
  ws.getColumn("C").width = 9;
  ws.getColumn("D").width = 12;
  ws.getColumn("E").width = 10;

  // Row 1 — title
  ws.getRow(1).height = 30;
  ws.mergeCells("A1:E1");
  const titleCell = ws.getCell("A1");
  titleCell.value = "DICKER DATA — PRICE & STOCK LOOKUP";
  titleCell.font  = fnt({ bold: true, size: 14, color: { argb: WHITE } });
  titleCell.fill  = solid(DARK);
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
      { type: "expression", priority: 1, formulae: [`$C5>3`],            style: { font: { bold: true, color: { argb: RED_C   } } } },
      { type: "expression", priority: 2, formulae: [`AND($C5>1,$C5<=3)`], style: { font: { bold: true, color: { argb: AMBER_C } } } },
      { type: "expression", priority: 3, formulae: [`$C5<=1`],            style: { font: { bold: true, color: { argb: GREEN_C } } } },
    ],
  });

  // Row 10 — instruction
  ws.mergeCells("A10:E10");
  const instrCell = ws.getCell("A10");
  instrCell.value = "Paste vendor part numbers in the yellow cells (one per row). Results render below automatically.";
  instrCell.font  = fnt({ italic: true, color: { argb: GREY } });

  // Row 11 — input column header
  const pnHdr = ws.getCell("A11");
  pnHdr.value     = "PART NUMBER";
  pnHdr.font      = fnt({ bold: true, color: { argb: WHITE } });
  pnHdr.fill      = solid(DARK);
  pnHdr.alignment = { horizontal: "left", indent: 1 };

  // Rows 12…IN_END — empty input cells (user pastes their own SKUs)
  const thinIN = thin(IN_BORDER);
  for (let i = 0; i < R; i++) {
    const c = ws.getCell(IN_START + i, 1);
    c.fill   = solid(INFILL);
    c.font   = fnt();
    c.border = { top: thinIN, bottom: thinIN, left: thinIN, right: thinIN };
  }

  // RESULTS label
  ws.mergeCells(`A${RESULTS_ROW}:E${RESULTS_ROW}`);
  const resLabel = ws.getCell(`A${RESULTS_ROW}`);
  resLabel.value = "RESULTS";
  resLabel.font  = fnt({ bold: true, size: 11, color: { argb: DARK } });

  // Output column headers
  const colHdrLabels = ["Part Number","Description / Distributor","SOH","Price (ex)","On Order"];
  colHdrLabels.forEach((h, i) => {
    const c = ws.getCell(COL_HDR_ROW, i + 1);
    c.value     = h;
    c.font      = fnt({ bold: true, color: { argb: WHITE } });
    c.fill      = solid(DARK);
    c.alignment = { horizontal: i <= 1 ? "left" : "center", vertical: "middle", indent: i <= 1 ? 1 : 0 };
  });

  // ─── Output blocks (one 4-row block per input slot) ─────────
  const USE_FORMULAS = R <= 500;
  const topBorder = { top: thin(BLK_BORDER) };

  for (let k = 0; k < R; k++) {
    const base = OUT0 + 4 * k;
    const ic   = `$A$${IN_START + k}`;
    const mf   = `MATCH(UPPER(SUBSTITUTE(TRIM(${ic})," ","")),DATA!$A:$A,0)`;

    if (USE_FORMULAS) {
      // Dicker row
      const aD = ws.getCell(base, 1);
      aD.value  = { formula: `IF(${ic}="","",${ic})` };
      aD.font   = fnt({ bold: true, color: { argb: DARK } });
      aD.border = topBorder;

      const bD = ws.getCell(base, 2);
      bD.value  = { formula: `IF(${ic}="","",IFERROR(INDEX(DATA!$C:$C,${mf}),"— part not found —"))` };
      bD.border = topBorder;

      const cD = ws.getCell(base, 3);
      cD.value     = { formula: `IF(${ic}="","",IF(ISNUMBER($D${base}),INDEX(DATA!$D:$D,${mf}),""))` };
      cD.font      = fnt({ bold: true, color: { argb: DARK } });
      cD.alignment = { horizontal: "center" };
      cD.border    = topBorder;

      const dD = ws.getCell(base, 4);
      dD.value     = { formula: `IF(${ic}="","",IFERROR(IF(INDEX(DATA!$E:$E,${mf})=0,"not stocked",INDEX(DATA!$E:$E,${mf})),"not stocked"))` };
      dD.font      = fnt({ bold: true, color: { argb: DARK } });
      dD.alignment = { horizontal: "center" };
      dD.numFmt    = "$#,##0.00";
      dD.border    = topBorder;

      ws.getCell(base, 5).border = topBorder;

      // Ingram row
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

      // Synnex row
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

      // Leader row
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

    } else {
      // Static values (R > 500)
      const row = dataRows[k];

      const aD = ws.getCell(base, 1);
      aD.value  = row.key;
      aD.font   = fnt({ bold: true, color: { argb: DARK } });
      aD.border = topBorder;

      const bD = ws.getCell(base, 2);
      bD.value  = row.desc || "— part not found —";
      bD.border = topBorder;

      const cD = ws.getCell(base, 3);
      cD.value     = row.dicker_soh;
      cD.font      = fnt({ bold: true, color: { argb: DARK } });
      cD.alignment = { horizontal: "center" };
      cD.border    = topBorder;

      const dD = ws.getCell(base, 4);
      dD.value     = row.dicker_price ?? "not stocked";
      dD.font      = fnt({ bold: true, color: { argb: DARK } });
      dD.alignment = { horizontal: "center" };
      if (row.dicker_price != null) dD.numFmt = "$#,##0.00";
      dD.border    = topBorder;

      ws.getCell(base, 5).border = topBorder;

      const bI = ws.getCell(base + 1, 2);
      bI.value     = "▸ Ingram";
      bI.font      = fnt({ color: { argb: TEAL } });
      bI.alignment = { horizontal: "right" };
      const cI = ws.getCell(base + 1, 3);
      cI.value = row.ingram_soh; cI.alignment = { horizontal: "center" };
      const dI = ws.getCell(base + 1, 4);
      dI.value = row.ingram_price ?? "not listed"; dI.alignment = { horizontal: "center" };
      if (row.ingram_price != null) dI.numFmt = "$#,##0.00";
      const eI = ws.getCell(base + 1, 5);
      eI.value = row.ingram_oo; eI.alignment = { horizontal: "center" };

      const bS = ws.getCell(base + 2, 2);
      bS.value     = "▸ Synnex";
      bS.font      = fnt({ color: { argb: TEAL } });
      bS.alignment = { horizontal: "right" };
      const cS = ws.getCell(base + 2, 3);
      cS.value = row.synnex_soh; cS.alignment = { horizontal: "center" };
      const dS = ws.getCell(base + 2, 4);
      dS.value = row.synnex_price ?? "not listed"; dS.alignment = { horizontal: "center" };
      if (row.synnex_price != null) dS.numFmt = "$#,##0.00";

      const bL = ws.getCell(base + 3, 2);
      bL.value     = "▸ Leader";
      bL.font      = fnt({ color: { argb: TEAL } });
      bL.alignment = { horizontal: "right" };
      const cL = ws.getCell(base + 3, 3);
      cL.value = row.leader_soh; cL.alignment = { horizontal: "center" };
      const dL = ws.getCell(base + 3, 4);
      dL.value = row.leader_price ?? "not listed"; dL.alignment = { horizontal: "center" };
      if (row.leader_price != null) dL.numFmt = "$#,##0.00";
    }
  }

  // Price conditional formatting over output range (formula mode only)
  if (USE_FORMULAS && R > 0) {
    const cfRef = `D${OUT0}:D${OUT0 + 4 * R - 1}`;
    ws.addConditionalFormatting({
      ref: cfRef,
      rules: [
        {
          type: "expression",
          priority: 1,
          formulae: [`AND(MOD(ROW()-${OUT0},4)<>0,ISNUMBER(D${OUT0}),ISNUMBER(INDEX($D:$D,${OUT0}+4*INT((ROW()-${OUT0})/4))),D${OUT0}<INDEX($D:$D,${OUT0}+4*INT((ROW()-${OUT0})/4)))`],
          style: { font: { bold: true, color: { argb: RED_C   } } },
        },
        {
          type: "expression",
          priority: 2,
          formulae: [`AND(MOD(ROW()-${OUT0},4)<>0,ISNUMBER(D${OUT0}),ISNUMBER(INDEX($D:$D,${OUT0}+4*INT((ROW()-${OUT0})/4))),D${OUT0}>INDEX($D:$D,${OUT0}+4*INT((ROW()-${OUT0})/4)))`],
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
