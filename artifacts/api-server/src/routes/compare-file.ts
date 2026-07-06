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
  const brandsParam = (req.query.brands      as string | undefined) ?? "";
  const distParam   = (req.query.distributors as string | undefined) ?? "";

  const selectedBrands  = brandsParam.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean);
  const selectedDistIds = distParam.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));

  // ── 1. Distributors ─────────────────────────────────────────
  const allDists      = await db.select().from(distributorsTable).orderBy(distributorsTable.id);
  const dickerDist    = allDists.find((d) => d.isBaseline);
  const allCompetitors = allDists.filter((d) => !d.isBaseline);
  const competitors   = selectedDistIds.length > 0
    ? allCompetitors.filter((d) => selectedDistIds.includes(d.id))
    : allCompetitors;

  // DATA sheet column layout (1-based):
  //   1=key, 2=brand, 3=desc, 4=dicker_soh, 5=dicker_price,
  //   then per competitor (3 cols each): soh, price, oo
  //   competitor i (0-based): colSoh=6+3i, colPrice=7+3i, colOo=8+3i
  interface CompetitorMeta {
    id: number; name: string; label: string;
    colSoh: number; colPrice: number; colOo: number;
  }
  const competitorMeta: CompetitorMeta[] = competitors.map((d, i) => ({
    id: d.id, name: d.name, label: `▸ ${d.name}`,
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

  // ── 5a. Horizontal format (formula-driven, paste-column input) ──
  if (req.query.format === "horizontal") {
    // COMPARISON sheet column layout (1-based):
    //   1 = paste VPN (yellow)       — user pastes SKUs here
    //   2 = Brand                    — formula from DATA
    //   3 = Description              — formula from DATA
    //   4 = Dicker SOH               — formula from DATA
    //   5 = Dicker Price (E)         — formula from DATA
    //   per competitor i (0-based):
    //     6+4i = SOH, 7+4i = Price, 8+4i = Δ$, 9+4i = Δ%
    //   trailing: COL_CHEAPEST, COL_FLAG
    //
    // DATA sheet column layout (1-based, no header row):
    //   1=key, 2=brand, 3=desc, 4=dicker_soh, 5=dicker_price
    //   per competitor i: 6+2i=soh, 7+2i=price
    const BASE         = 5;
    const COMP_STRIDE  = 4;
    const numComp      = competitors.length;
    const compColSoh   = (i: number) => BASE + 1 + COMP_STRIDE * i;
    const compColPrice = (i: number) => BASE + 2 + COMP_STRIDE * i;
    const compColDelta = (i: number) => BASE + 3 + COMP_STRIDE * i;
    const compColDPct  = (i: number) => BASE + 4 + COMP_STRIDE * i;
    const COL_CHEAPEST = BASE + 1 + COMP_STRIDE * numComp;
    const COL_FLAG     = COL_CHEAPEST + 1;
    const TOTAL_COLS   = COL_FLAG;

    const dataColCompSoh   = (i: number) => 6 + 2 * i;
    const dataColCompPrice = (i: number) => 7 + 2 * i;

    const hwb     = new ExcelJS.Workbook();
    hwb.creator   = "DistiBench";
    const hws     = hwb.addWorksheet("COMPARISON");
    const hDataWs = hwb.addWorksheet("DATA", { state: "veryHidden" });

    // ── DATA sheet (row 1 = first product, no header) ──
    const sortedH = [...products].sort((a, b) => {
      if (a.brand < b.brand) return -1;
      if (a.brand > b.brand) return 1;
      const aSOH = dickerDist ? (snapMap.get(`${a.id}:${dickerDist.id}`)?.soh ?? -1) : -1;
      const bSOH = dickerDist ? (snapMap.get(`${b.id}:${dickerDist.id}`)?.soh ?? -1) : -1;
      return bSOH - aSOH;
    });
    for (const p of sortedH) {
      const dkSnap  = dickerDist ? snapMap.get(`${p.id}:${dickerDist.id}`) : undefined;
      const dkSOH   = dkSnap?.soh ?? null;
      const dkPrice = dkSnap?.sell_price != null ? parseFloat(dkSnap.sell_price) : null;
      const compCols = competitors.flatMap((c) => {
        const snap = snapMap.get(`${p.id}:${c.id}`);
        return [
          snap?.soh ?? null,
          snap?.sell_price != null ? parseFloat(snap.sell_price) : null,
        ];
      });
      hDataWs.addRow([p.vpnNormalized, p.brand, p.description, dkSOH, dkPrice, ...compCols]);
    }

    // ── COMPARISON sheet column widths ──
    hws.getColumn(1).width = 22;  // A: paste VPN
    hws.getColumn(2).width = 10;  // B: brand
    hws.getColumn(3).width = 40;  // C: description
    hws.getColumn(4).width = 9;   // D: dicker soh
    hws.getColumn(5).width = 12;  // E: dicker price
    for (let i = 0; i < numComp; i++) {
      hws.getColumn(compColSoh(i)).width   = 9;
      hws.getColumn(compColPrice(i)).width  = 12;
      hws.getColumn(compColDelta(i)).width  = 13;
      hws.getColumn(compColDPct(i)).width   = 9;
    }
    hws.getColumn(COL_CHEAPEST).width = 18;
    hws.getColumn(COL_FLAG).width     = 7;

    // ── Row 1: Title ──
    hws.getRow(1).height = 30;
    hws.mergeCells(1, 1, 1, TOTAL_COLS);
    const htitle = hws.getCell(1, 1);
    htitle.value     = "DICKER DATA — COMPETITOR PRICE COMPARISON";
    htitle.font      = fnt({ bold: true, size: 14, color: { argb: WHITE } });
    htitle.fill      = solid(DARK);
    htitle.alignment = { horizontal: "center", vertical: "middle" };

    // ── Row 3: Freshness label ──
    hws.mergeCells(3, 1, 3, TOTAL_COLS);
    const hfpLabel = hws.getCell(3, 1);
    hfpLabel.value = "PRICE FILE FRESHNESS — how current each distributor's feed is";
    hfpLabel.font  = fnt({ bold: true, color: { argb: DARK } });

    // ── Row 4: Freshness column headers ──
    ["Distributor", "Price file date", "Days old", "Status"].forEach((h, i) => {
      const c = hws.getCell(4, i + 1);
      c.value     = h;
      c.font      = fnt({ bold: true, size: 9, color: { argb: WHITE } });
      c.fill      = solid(GREY);
      c.alignment = { horizontal: "center", vertical: "middle" };
    });

    // ── Rows 5+: Per-distributor freshness ──
    const hFreshnessLines = [
      { label: "Dicker Data", dist: dickerDist },
      ...competitors.map((d) => ({ label: d.name, dist: d })),
    ];
    hFreshnessLines.forEach(({ label, dist }, idx) => {
      const rn    = 5 + idx;
      const aCell = hws.getCell(rn, 1);
      aCell.value = label;
      aCell.font  = fnt({ bold: true, color: { argb: DARK } });
      const bCell    = hws.getCell(rn, 2);
      const lastDate = dist ? freshnessMap.get(dist.id) : null;
      if (lastDate) {
        bCell.value  = new Date(lastDate + "T00:00:00");
        bCell.numFmt = "dd/mm/yyyy";
      } else {
        bCell.value = "No data";
      }
      const cCell = hws.getCell(rn, 3);
      cCell.value     = { formula: `TODAY()-B${rn}` };
      cCell.numFmt    = "0";
      cCell.alignment = { horizontal: "center" };
      const dCell = hws.getCell(rn, 4);
      dCell.value = { formula: `IF(C${rn}<=1,"current",IF(C${rn}<=3,"ageing — consider refresh","STALE — upload a new file"))` };
      dCell.font  = fnt({ bold: true });
    });
    const hFreshnessEnd = 4 + hFreshnessLines.length;
    hws.addConditionalFormatting({
      ref: `D5:D${hFreshnessEnd}`,
      rules: [
        { type: "expression", priority: 1, formulae: [`$C5>3`],             style: { font: { bold: true, color: { argb: RED_C   } } } },
        { type: "expression", priority: 2, formulae: [`AND($C5>1,$C5<=3)`], style: { font: { bold: true, color: { argb: AMBER_C } } } },
        { type: "expression", priority: 3, formulae: [`$C5<=1`],            style: { font: { bold: true, color: { argb: GREEN_C } } } },
      ],
    });

    // ── Instruction row ──
    const INSTR_ROW = hFreshnessEnd + 2;
    hws.mergeCells(INSTR_ROW, 1, INSTR_ROW, TOTAL_COLS);
    const instrCell = hws.getCell(INSTR_ROW, 1);
    instrCell.value = "Paste a list of SKUs into the yellow column (column A). Each row auto-populates with price and stock data across all distributors.";
    instrCell.font  = fnt({ italic: true, color: { argb: GREY } });

    // ── GRP_ROW: Distributor group headers ──
    const GRP_ROW = INSTR_ROW + 2;
    hws.getRow(GRP_ROW).height = 18;

    hws.mergeCells(GRP_ROW, 4, GRP_ROW, 5);
    const dkGrpCell = hws.getCell(GRP_ROW, 4);
    dkGrpCell.value     = dickerDist ? `${dickerDist.name} ★` : "Dicker Data ★";
    dkGrpCell.font      = fnt({ bold: true, color: { argb: WHITE } });
    dkGrpCell.fill      = solid(DARK);
    dkGrpCell.alignment = { horizontal: "center", vertical: "middle" };

    competitors.forEach((comp, i) => {
      hws.mergeCells(GRP_ROW, compColSoh(i), GRP_ROW, compColDPct(i));
      const gc = hws.getCell(GRP_ROW, compColSoh(i));
      gc.value     = comp.name;
      gc.font      = fnt({ bold: true, color: { argb: WHITE } });
      gc.fill      = solid(TEAL);
      gc.alignment = { horizontal: "center", vertical: "middle" };
    });

    // ── HDR_ROW: Sub-header row ──
    const HDR_ROW = GRP_ROW + 1;
    hws.getRow(HDR_ROW).height = 16;

    const subHdrs: Array<{ col: number; label: string }> = [
      { col: 1, label: "PASTE SKUs ▼" },
      { col: 2, label: "Brand" },
      { col: 3, label: "Description" },
      { col: 4, label: "SOH" },
      { col: 5, label: "Price (ex)" },
    ];
    for (let i = 0; i < numComp; i++) {
      subHdrs.push({ col: compColSoh(i),   label: "SOH"          });
      subHdrs.push({ col: compColPrice(i),  label: "Price (ex)"   });
      subHdrs.push({ col: compColDelta(i),  label: "Δ$ vs Dicker" });
      subHdrs.push({ col: compColDPct(i),   label: "Δ %"          });
    }
    subHdrs.push({ col: COL_CHEAPEST, label: "Cheapest" });
    subHdrs.push({ col: COL_FLAG,     label: "DD ↑" });

    subHdrs.forEach(({ col, label }) => {
      const c = hws.getCell(HDR_ROW, col);
      c.value     = label;
      c.font      = fnt({ bold: true, color: { argb: WHITE } });
      c.fill      = solid(DARK);
      c.alignment = { horizontal: col >= 4 ? "center" : "left", vertical: "middle", indent: col < 4 ? 1 : 0 };
    });

    // Freeze first 3 cols (paste/brand/desc) and all header rows
    hws.views = [{ showGridLines: true, state: "frozen", xSplit: 3, ySplit: HDR_ROW }];

    // ── Formula rows (M paste slots) ──
    const DATA_START = HDR_ROW + 1;
    const M          = 300;
    const thinIN     = thin(IN_BORDER);

    for (let k = 0; k < M; k++) {
      const r = DATA_START + k;

      // Col A — yellow paste cell
      const pasteCell = hws.getCell(r, 1);
      pasteCell.fill   = solid(INFILL);
      pasteCell.font   = fnt({ color: { argb: DARK } });
      pasteCell.border = { top: thinIN, bottom: thinIN, left: thinIN, right: thinIN };

      // Shared formula fragments for this row
      const aRef  = `A${r}`;
      const norm  = `UPPER(SUBSTITUTE(TRIM(${aRef})," ",""))`;
      const mf    = `MATCH(${norm},DATA!$A:$A,0)`;
      // guard prefix: IF(A{r}="","", ...inner... ) — inner must close with ))
      const g = `IF(${aRef}="","",`;

      // Col B — Brand
      const brandCell = hws.getCell(r, 2);
      brandCell.value = { formula: `${g}IFERROR(INDEX(DATA!$B:$B,${mf}),"— not found —"))` };
      brandCell.font  = fnt({ color: { argb: DARK } });

      // Col C — Description
      const descCell = hws.getCell(r, 3);
      descCell.value = { formula: `${g}IFERROR(INDEX(DATA!$C:$C,${mf}),"— not found —"))` };
      descCell.font  = fnt({ color: { argb: DARK } });

      // Col D — Dicker SOH
      const dkSohCell = hws.getCell(r, 4);
      dkSohCell.value     = { formula: `${g}IFERROR(INDEX(DATA!$D:$D,${mf}),""))` };
      dkSohCell.font      = fnt({ bold: true, color: { argb: DARK } });
      dkSohCell.alignment = { horizontal: "center" };

      // Col E — Dicker Price
      const dkPriceCell = hws.getCell(r, 5);
      dkPriceCell.value     = { formula: `${g}IFERROR(INDEX(DATA!$E:$E,${mf}),""))` };
      dkPriceCell.font      = fnt({ bold: true, color: { argb: DARK } });
      dkPriceCell.numFmt    = "$#,##0.00";
      dkPriceCell.alignment = { horizontal: "center" };

      // Competitor columns — collect price cell refs for cheapest/flag formulas
      const compPriceRefs: string[] = [];
      for (let i = 0; i < numComp; i++) {
        const dataSOHLtr   = colLetter(dataColCompSoh(i));
        const dataPriceLtr = colLetter(dataColCompPrice(i));
        const priceLtr     = colLetter(compColPrice(i));
        compPriceRefs.push(`${priceLtr}${r}`);

        // SOH
        const sohCell = hws.getCell(r, compColSoh(i));
        sohCell.value     = { formula: `${g}IFERROR(INDEX(DATA!$${dataSOHLtr}:$${dataSOHLtr},${mf}),""))` };
        sohCell.font      = fnt({ color: { argb: DARK } });
        sohCell.alignment = { horizontal: "center" };

        // Price
        const priceCell = hws.getCell(r, compColPrice(i));
        priceCell.value     = { formula: `${g}IFERROR(INDEX(DATA!$${dataPriceLtr}:$${dataPriceLtr},${mf}),""))` };
        priceCell.font      = fnt({ color: { argb: DARK } });
        priceCell.numFmt    = "$#,##0.00";
        priceCell.alignment = { horizontal: "center" };

        // Δ$ — competitor price minus Dicker price
        const deltaCell = hws.getCell(r, compColDelta(i));
        deltaCell.value     = { formula: `IF(OR(E${r}="",${priceLtr}${r}=""),"",${priceLtr}${r}-E${r})` };
        deltaCell.numFmt    = `$#,##0.00`;
        deltaCell.alignment = { horizontal: "center" };
        deltaCell.font      = fnt({ color: { argb: DARK } });

        // Δ% — (competitor - dicker) / dicker
        const dpctCell = hws.getCell(r, compColDPct(i));
        dpctCell.value     = { formula: `IF(OR(E${r}="",${priceLtr}${r}="",E${r}=0),"",( ${priceLtr}${r}-E${r})/E${r})` };
        dpctCell.numFmt    = `+0.0%;-0.0%;`;
        dpctCell.alignment = { horizontal: "center" };
        dpctCell.font      = fnt({ color: { argb: DARK } });
      }

      // Cheapest — MIN price across all competitor price cells in this row
      const cheapestCell = hws.getCell(r, COL_CHEAPEST);
      cheapestCell.font      = fnt({ bold: true, color: { argb: TEAL } });
      cheapestCell.numFmt    = "$#,##0.00";
      cheapestCell.alignment = { horizontal: "center" };
      if (numComp === 0) {
        cheapestCell.value = "";
      } else {
        const priceList = compPriceRefs.join(",");
        cheapestCell.value = { formula: `IF(OR(${aRef}="",COUNT(${priceList})=0),"",MIN(${priceList}))` };
      }

      // DD↑ — flag when Dicker is more expensive than the cheapest competitor
      const flagCell = hws.getCell(r, COL_FLAG);
      flagCell.font      = fnt({ bold: true, color: { argb: RED_C } });
      flagCell.alignment = { horizontal: "center" };
      if (numComp === 0) {
        flagCell.value = "";
      } else {
        const minExpr = `MIN(${compPriceRefs.join(",")})`;
        flagCell.value = { formula: `IF(OR(${aRef}="",E${r}="",COUNT(${compPriceRefs.join(",")})=0),"",IF(ISNUMBER(E${r}),IF(E${r}>${minExpr},"⚑",""),""))` };
      }

      // Zebra stripe (cols 2 onwards — col A stays always yellow)
      if (k % 2 === 1) {
        for (let col = 2; col <= TOTAL_COLS; col++) {
          const cell     = hws.getCell(r, col);
          const existing = cell.fill as ExcelJS.FillPattern | undefined;
          if (!existing?.fgColor?.argb || existing.fgColor.argb === WHITE) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
          }
        }
      }
    }

    // ── CF: competitor price, Δ$, Δ% columns ──
    // Price: red when cheaper than Dicker, green when more expensive
    // Δ$ / Δ%: red when negative (competitor cheaper), green when positive
    for (let i = 0; i < numComp; i++) {
      const pLtr     = colLetter(compColPrice(i));
      const deltaLtr = colLetter(compColDelta(i));
      const dpctLtr  = colLetter(compColDPct(i));
      const first    = DATA_START;
      const last     = DATA_START + M - 1;

      // Price column
      hws.addConditionalFormatting({
        ref: `${pLtr}${first}:${pLtr}${last}`,
        rules: [
          {
            type: "expression", priority: 1,
            formulae: [`AND(ISNUMBER(${pLtr}${first}),ISNUMBER(E${first}),${pLtr}${first}<E${first})`],
            style: { font: { bold: true, color: { argb: RED_C } } },
          },
          {
            type: "expression", priority: 2,
            formulae: [`AND(ISNUMBER(${pLtr}${first}),ISNUMBER(E${first}),${pLtr}${first}>E${first})`],
            style: { font: { bold: true, color: { argb: GREEN_C } } },
          },
        ],
      });

      // Δ$ column — negative = competitor cheaper = red
      hws.addConditionalFormatting({
        ref: `${deltaLtr}${first}:${deltaLtr}${last}`,
        rules: [
          {
            type: "expression", priority: 1,
            formulae: [`AND(ISNUMBER(${deltaLtr}${first}),${deltaLtr}${first}<0)`],
            style: { font: { bold: true, color: { argb: RED_C } } },
          },
          {
            type: "expression", priority: 2,
            formulae: [`AND(ISNUMBER(${deltaLtr}${first}),${deltaLtr}${first}>0)`],
            style: { font: { bold: true, color: { argb: GREEN_C } } },
          },
        ],
      });

      // Δ% column — same sign logic
      hws.addConditionalFormatting({
        ref: `${dpctLtr}${first}:${dpctLtr}${last}`,
        rules: [
          {
            type: "expression", priority: 1,
            formulae: [`AND(ISNUMBER(${dpctLtr}${first}),${dpctLtr}${first}<0)`],
            style: { font: { bold: true, color: { argb: RED_C } } },
          },
          {
            type: "expression", priority: 2,
            formulae: [`AND(ISNUMBER(${dpctLtr}${first}),${dpctLtr}${first}>0)`],
            style: { font: { bold: true, color: { argb: GREEN_C } } },
          },
        ],
      });
    }

    // ── Stream response ──
    const brandLabel = selectedBrands.length > 0 ? selectedBrands.join("_") : "ALL";
    const today      = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const hfname     = `Compare_Horizontal_${brandLabel}_${today}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${hfname}"`);
    await hwb.xlsx.write(res);
    res.end();
    return;
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

  const sortedProducts = [...products].sort((a, b) => {
    if (a.brand < b.brand) return -1;
    if (a.brand > b.brand) return 1;
    const aSnap = dickerDist ? snapMap.get(`${a.id}:${dickerDist.id}`) : undefined;
    const bSnap = dickerDist ? snapMap.get(`${b.id}:${dickerDist.id}`) : undefined;
    const aSOH  = (aSnap?.soh ?? null) ?? -1;
    const bSOH  = (bSnap?.soh ?? null) ?? -1;
    return bSOH - aSOH;
  });

  for (const p of sortedProducts) {
    const dkSnap  = dickerDist ? snapMap.get(`${p.id}:${dickerDist.id}`) : undefined;
    const rawSoh  = dkSnap?.soh ?? null;
    const dkSOH   = rawSoh;
    const dkPrice = dkSnap?.sell_price != null ? parseFloat(dkSnap.sell_price) : null;
    const compCols = competitorMeta.flatMap((c) => {
      const snap = snapMap.get(`${p.id}:${c.id}`);
      return [
        snap?.soh ?? null,
        snap?.sell_price != null ? parseFloat(snap.sell_price) : null,
        snap?.soo ?? null,
      ];
    });
    dataWs.addRow([p.vpnNormalized, p.brand, p.description, dkSOH, dkPrice, ...compCols]);
  }

  // ─── LOOKUP sheet ──────────────────────────────────────────
  // Layout: 7 columns A–G
  //   A (col 1, w=24) — plain unmerged paste column; user pastes a column of SKUs here
  //   B (col 2, w=3)  — visual gap
  //   C (col 3, w=22) — Part Number echo (Dicker row only)
  //   D (col 4, w=50) — Description (Dicker) / distributor label (competitors)
  //   E (col 5, w=9)  — SOH
  //   F (col 6, w=12) — Price (ex)
  //   G (col 7, w=10) — On Order
  //
  // M = paste column height (empty slots). Cards: card k => base = 13 + blockSize*k.
  // inref = INDEX($A$13:$A$LAST, k+1) — each card pulls the k-th paste cell.
  // No merged cells anywhere — a column paste of any length drops straight in.

  const M         = 300;
  const blockSize = 1 + competitorMeta.length;
  const PASTE_START = 13;
  const PASTE_END   = PASTE_START + M - 1;       // last paste row
  const CARD_END    = PASTE_START + blockSize * M - 1; // last card row
  const HDR_ROW     = 12;                         // zone header row

  // Column widths
  ws.getColumn(1).width = 24;  // A paste
  ws.getColumn(2).width = 3;   // B gap
  ws.getColumn(3).width = 22;  // C part number echo
  ws.getColumn(4).width = 50;  // D description / label
  ws.getColumn(5).width = 9;   // E SOH
  ws.getColumn(6).width = 12;  // F price
  ws.getColumn(7).width = 10;  // G on order

  // Freeze rows 1–12 (freshness strip + zone header stay visible)
  ws.views = [{ showGridLines: false, state: "frozen", xSplit: 0, ySplit: HDR_ROW }];

  // ── Row 1 — title ──
  ws.getRow(1).height = 30;
  ws.mergeCells(1, 1, 1, 7);
  const titleCell = ws.getCell(1, 1);
  titleCell.value     = "DICKER DATA — PRICE & STOCK LOOKUP";
  titleCell.font      = fnt({ bold: true, size: 14, color: { argb: WHITE } });
  titleCell.fill      = solid(DARK);
  titleCell.alignment = { horizontal: "center", vertical: "middle" };

  // ── Row 3 — freshness panel label ──
  ws.mergeCells(3, 1, 3, 7);
  const fpLabel = ws.getCell(3, 1);
  fpLabel.value = "PRICE FILE FRESHNESS — how current each distributor's feed is (upload / refresh when a feed goes stale)";
  fpLabel.font  = fnt({ bold: true, color: { argb: DARK } });

  // ── Row 4 — freshness column headers ──
  (["Distributor","Price file date","Days old","Status"] as const).forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value     = h;
    c.font      = fnt({ bold: true, size: 9, color: { argb: WHITE } });
    c.fill      = solid(GREY);
    c.alignment = { horizontal: "center", vertical: "middle" };
  });

  // ── Rows 5..N — per-distributor freshness ──
  const freshnessLines = [
    { label: "Dicker Data", dist: dickerDist },
    ...competitors.map((d) => ({ label: d.name, dist: d })),
  ];
  freshnessLines.forEach(({ label, dist }, idx) => {
    const rn = 5 + idx;
    const aCell = ws.getCell(rn, 1);
    aCell.value = label;
    aCell.font  = fnt({ bold: true, color: { argb: DARK } });

    const bCell    = ws.getCell(rn, 2);
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

  // ── Row 10 — instruction ──
  ws.mergeCells(10, 1, 10, 7);
  const instrCell = ws.getCell(10, 1);
  instrCell.value = "Paste a whole list of SKUs into the yellow column (column A). The comparison cards on the right build themselves — one stacked card per SKU, in order.";
  instrCell.font  = fnt({ italic: true, color: { argb: GREY } });

  // ── Row 12 — zone headers ──
  const hdrA = ws.getCell(HDR_ROW, 1);
  hdrA.value     = "PASTE SKUs ▼";
  hdrA.font      = fnt({ bold: true, color: { argb: WHITE } });
  hdrA.fill      = solid(DARK);
  hdrA.alignment = { horizontal: "left", indent: 1 };

  const zoneHdrs = [
    { col: 3, label: "Part Number",              center: false },
    { col: 4, label: "Description / Distributor", center: false },
    { col: 5, label: "SOH",                       center: true  },
    { col: 6, label: "Price (ex)",                center: true  },
    { col: 7, label: "On Order",                  center: true  },
  ];
  zoneHdrs.forEach(({ col, label, center }) => {
    const c = ws.getCell(HDR_ROW, col);
    c.value     = label;
    c.font      = fnt({ bold: true, color: { argb: WHITE } });
    c.fill      = solid(DARK);
    c.alignment = { horizontal: center ? "center" : "left", vertical: "middle", indent: center ? 0 : 1 };
  });

  // ── Paste column A13:A{PASTE_END} — empty yellow cells ──
  const thinIN  = thin(IN_BORDER);
  for (let i = 0; i < M; i++) {
    const c = ws.getCell(PASTE_START + i, 1);
    c.fill   = solid(INFILL);
    c.font   = fnt({ bold: false, color: { argb: DARK } });
    c.border = { top: thinIN, bottom: thinIN, left: thinIN, right: thinIN };
  }

  // ── Cards (formula mode always, M is small enough) ──
  const topBlk = thin(BLK_BORDER);
  // DATA column letters for Dicker
  const dkDescLtr  = "C";  // DATA col 3
  const dkSohLtr   = "D";  // DATA col 4
  const dkPriceLtr = "E";  // DATA col 5

  for (let k = 0; k < M; k++) {
    const base   = PASTE_START + blockSize * k;
    const inref  = `INDEX($A$${PASTE_START}:$A$${PASTE_END},${k + 1})`;
    const norm   = `UPPER(SUBSTITUTE(TRIM(${inref})," ",""))`;
    const mf     = `MATCH(${norm},DATA!$A:$A,0)`;

    // Thin separator across A–G on the Dicker row
    for (let col = 1; col <= 7; col++) {
      const existing = ws.getCell(base, col).border ?? {};
      ws.getCell(base, col).border = { ...existing, top: topBlk };
    }

    // Dicker row — cols C, D, E, F
    const cD = ws.getCell(base, 3);
    cD.value  = { formula: `IF(${inref}="","",${inref})` };
    cD.font   = fnt({ bold: true, color: { argb: DARK } });

    const dD = ws.getCell(base, 4);
    dD.value  = { formula: `IF(${inref}="","",IFERROR(INDEX(DATA!$${dkDescLtr}:$${dkDescLtr},${mf}),"— part not found —"))` };
    dD.font   = fnt({ color: { argb: DARK } });

    const eD = ws.getCell(base, 5);
    eD.value     = { formula: `IF(${inref}="","",IF(ISNUMBER($F${base}),INDEX(DATA!$${dkSohLtr}:$${dkSohLtr},${mf}),""))` };
    eD.font      = fnt({ bold: true, color: { argb: DARK } });
    eD.alignment = { horizontal: "center" };

    const fD = ws.getCell(base, 6);
    fD.value     = { formula: `IF(${inref}="","",IFERROR(IF(INDEX(DATA!$${dkPriceLtr}:$${dkPriceLtr},${mf})="","not listed",INDEX(DATA!$${dkPriceLtr}:$${dkPriceLtr},${mf})),"not listed"))` };
    fD.font      = fnt({ bold: true, color: { argb: DARK } });
    fD.alignment = { horizontal: "center" };
    fD.numFmt    = "$#,##0.00";

    // Competitor rows
    competitorMeta.forEach((c, ci) => {
      const row      = base + 1 + ci;
      const sohLtr   = colLetter(c.colSoh);
      const priceLtr = colLetter(c.colPrice);
      const ooLtr    = colLetter(c.colOo);

      const dC = ws.getCell(row, 4);
      dC.value     = { formula: `IF(${inref}="","","${c.label}")` };
      dC.font      = fnt({ color: { argb: TEAL } });
      dC.alignment = { horizontal: "right" };

      const eC = ws.getCell(row, 5);
      eC.value     = { formula: `IF(${inref}="","",IF(ISNUMBER($F${row}),INDEX(DATA!$${sohLtr}:$${sohLtr},${mf}),""))` };
      eC.alignment = { horizontal: "center" };

      const fC = ws.getCell(row, 6);
      fC.value     = { formula: `IF(${inref}="","",IFERROR(IF(INDEX(DATA!$${priceLtr}:$${priceLtr},${mf})=0,"not listed",INDEX(DATA!$${priceLtr}:$${priceLtr},${mf})),"not listed"))` };
      fC.alignment = { horizontal: "center" };
      fC.numFmt    = "$#,##0.00";

      const gC = ws.getCell(row, 7);
      gC.value     = { formula: `IF(${inref}="","",IF(ISNUMBER($F${row}),INDEX(DATA!$${ooLtr}:$${ooLtr},${mf}),""))` };
      gC.alignment = { horizontal: "center" };
    });
  }

  // ─── Price CF on column F ──────────────────────────────────
  // Competitor rows: MOD(ROW()-PASTE_START, blockSize) <> 0
  // Dicker price for current block: INDEX($F:$F, PASTE_START + blockSize*INT((ROW()-PASTE_START)/blockSize))
  if (competitorMeta.length > 0) {
    const cfStart   = PASTE_START;
    const cfEnd     = CARD_END;
    const dickerRef = `${cfStart}+${blockSize}*INT((ROW()-${cfStart})/${blockSize})`;
    const isComp    = `MOD(ROW()-${cfStart},${blockSize})<>0`;
    const dkP       = `INDEX($F:$F,${dickerRef})`;
    const thisP     = `F${cfStart}`;
    ws.addConditionalFormatting({
      ref: `F${cfStart}:F${cfEnd}`,
      rules: [
        {
          type: "expression", priority: 1,
          formulae: [`AND(${isComp},ISNUMBER(${thisP}),ISNUMBER(${dkP}),${thisP}<${dkP})`],
          style: { font: { bold: true, color: { argb: RED_C   } } },
        },
        {
          type: "expression", priority: 2,
          formulae: [`AND(${isComp},ISNUMBER(${thisP}),ISNUMBER(${dkP}),${thisP}>${dkP})`],
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
