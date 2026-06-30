import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { parse as csvParseSync } from "csv-parse/sync";
import { db, distributorsTable, importProfilesTable, uploadsTable, productsTable, stockSnapshotsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { buildBrandMap, resolveCanonicalBrand } from "../lib/brands";
import { normalizeVpn } from "../lib/vpn";

// ---------------------------------------------------------------------------
// Distributor fingerprints for auto-detection
// ---------------------------------------------------------------------------

interface ColumnMapping {
  vpn: string;
  brand: string;
  description: string;
  sell_price: string;
  soh: string;
  soo: string | null;
}

interface DistributorFingerprint {
  namePattern: string;
  signatures: string[];
  mapping: ColumnMapping;
}

const FINGERPRINTS: DistributorFingerprint[] = [
  {
    namePattern: "dicker",
    signatures: ["StockCode", "VendorStockCode", "DealerEx", "StockAvailable"],
    mapping: {
      vpn: "VendorStockCode",
      brand: "Vendor",
      description: "StockDescription",
      sell_price: "DealerEx",
      soh: "StockAvailable",
      soo: null,
    },
  },
  {
    namePattern: "ingram",
    signatures: ["Vendor Part Number", "Customer Price", "Available Quantity", "Vendor Name"],
    mapping: {
      vpn: "Vendor Part Number",
      brand: "Vendor Name",
      description: "Ingram Part Description",
      sell_price: "Customer Price",
      soh: "Available Quantity",
      soo: "Backlog Information",
    },
  },
  {
    namePattern: "leader",
    signatures: ["MANUFACTURER SKU", "DBP", "AT", "MANUFACTURER"],
    mapping: {
      vpn: "MANUFACTURER SKU",
      brand: "MANUFACTURER",
      description: "SHORT DESCRIPTION",
      sell_price: "DBP",
      soh: "AT",
      soo: null,
    },
  },
  {
    namePattern: "synnex",
    signatures: ["MANUFACTURER_PART_NUMBER", "RESELLER_BUY_EX", "TOTAL_AVAILABILITY", "MANUFACTURER_NAME"],
    mapping: {
      vpn: "MANUFACTURER_PART_NUMBER",
      brand: "MANUFACTURER_NAME",
      description: "PRODUCT_DESCRIPTION",
      sell_price: "RESELLER_BUY_EX",
      soh: "TOTAL_AVAILABILITY",
      soo: null,
    },
  },
  {
    // MMT: "Man.Code/SKU" is the manufacturer part number (VPN)
    namePattern: "mmt",
    signatures: ["Man.Code/SKU", "Your Buy Ex. GST", "Available (Qty)", "MMT Code"],
    mapping: {
      vpn: "Man.Code/SKU",
      brand: "Manufacturer",
      description: "Description",
      sell_price: "Your Buy Ex. GST",
      soh: "Available (Qty)",
      soo: null,
    },
  },
  {
    // Bluechip: "SupplierPartNumber" is the manufacturer part number (VPN)
    namePattern: "bluechip",
    signatures: ["SupplierPartNumber", "Cost_EX_GST", "NSW_Qty", "VIC_Qty"],
    mapping: {
      vpn: "SupplierPartNumber",
      brand: "Manufacturer",
      description: "Description",
      sell_price: "Cost_EX_GST",
      soh: "Qty",
      soo: null,
    },
  },
];

async function detectDistributor(columns: string[]): Promise<{
  distributorId: number | null;
  distributorName: string | null;
  mapping: ColumnMapping | null;
}> {
  const colsLower = new Set(columns.map((c) => c.toLowerCase()));
  const allDistributors = await db.select().from(distributorsTable);

  let bestScore = 0;
  let result = { distributorId: null as number | null, distributorName: null as string | null, mapping: null as ColumnMapping | null };

  // Try hardcoded fingerprints
  for (const fp of FINGERPRINTS) {
    const score = fp.signatures.filter((s) => colsLower.has(s.toLowerCase())).length;
    if (score > bestScore) {
      const dist = allDistributors.find((d) => d.name.toLowerCase().includes(fp.namePattern));
      if (dist) {
        bestScore = score;
        // Only use fingerprint mapping for columns that actually exist in this file
        const safeMapping: ColumnMapping = {
          vpn: columns.find((c) => c === fp.mapping.vpn) ?? fp.mapping.vpn,
          brand: columns.find((c) => c === fp.mapping.brand) ?? fp.mapping.brand,
          description: columns.find((c) => c === fp.mapping.description) ?? "",
          sell_price: columns.find((c) => c === fp.mapping.sell_price) ?? fp.mapping.sell_price,
          soh: columns.find((c) => c === fp.mapping.soh) ?? fp.mapping.soh,
          soo: fp.mapping.soo ? (columns.find((c) => c === fp.mapping.soo) ?? null) : null,
        };
        result = { distributorId: dist.id, distributorName: dist.name, mapping: safeMapping };
      }
    }
  }

  // If no fingerprint matched well (score < 2), also try saved profiles
  if (bestScore < 2) {
    const profiles = await db.select().from(importProfilesTable);
    for (const profile of profiles) {
      const profileMapping = profile.mapping as Record<string, string | null>;
      const profileCols = Object.values(profileMapping).filter(Boolean) as string[];
      const score = profileCols.filter((c) => colsLower.has(c.toLowerCase())).length;
      if (score > bestScore) {
        const dist = allDistributors.find((d) => d.id === profile.distributorId);
        if (dist) {
          bestScore = score;
          result = { distributorId: dist.id, distributorName: dist.name, mapping: profileMapping as unknown as ColumnMapping };
        }
      }
    }
  }

  return result;
}

const router = Router();

// Resolve uploads dir relative to workspace root
const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();
const uploadsDir = path.resolve(workspaceRoot, "artifacts/api-server/uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function sniffDelimiter(sample: string): string {
  const counts = {
    "\t": (sample.match(/\t/g) || []).length,
    ",": (sample.match(/,/g) || []).length,
    "|": (sample.match(/\|/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseDelimited(content: string, delimiter: string, headerRowIndex: number): { columns: string[]; rows: Record<string, string>[] } {
  try {
    const records = csvParseSync(content, {
      delimiter,
      from_line: headerRowIndex + 1,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }) as string[][];

    if (!records.length) return { columns: [], rows: [] };

    const columns = records[0].map((c) => String(c ?? "").trim());
    const rows: Record<string, string>[] = [];

    for (let i = 1; i < records.length; i++) {
      const cells = records[i];
      if (!cells || cells.every((c) => !c)) continue;
      const row: Record<string, string> = {};
      columns.forEach((col, idx) => {
        row[col] = String(cells[idx] ?? "").trim();
      });
      rows.push(row);
    }

    return { columns, rows };
  } catch {
    return { columns: [], rows: [] };
  }
}

async function parseXlsx(filePath: string, headerRowIndex: number): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const XLSX = await import("xlsx");
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
  const headerRow = raw[headerRowIndex] as string[];
  if (!headerRow) return { columns: [], rows: [] };
  const columns = headerRow.map((c) => String(c ?? "").trim());
  const rows: Record<string, string>[] = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const cells = raw[i] as (string | number | null | undefined)[];
    if (!cells || cells.every((c) => c == null || c === "")) continue;
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = String(cells[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return { columns, rows };
}

// GET /uploads
router.get("/uploads", requireAuth, async (req, res): Promise<void> => {
  const distributorId = req.query.distributorId ? Number(req.query.distributorId) : undefined;

  const query = db.select().from(uploadsTable).orderBy(desc(uploadsTable.uploadedAt));
  const uploads = distributorId
    ? await db.select().from(uploadsTable).where(eq(uploadsTable.distributorId, distributorId)).orderBy(desc(uploadsTable.uploadedAt))
    : await db.select().from(uploadsTable).orderBy(desc(uploadsTable.uploadedAt));

  const [dist] = distributorId
    ? await db.select().from(distributorsTable).where(eq(distributorsTable.id, distributorId))
    : [];

  const result = uploads.map((u) => ({
    id: u.id,
    distributorId: u.distributorId,
    distributorName: dist?.name ?? "",
    filename: u.filename,
    uploadedAt: u.uploadedAt.toISOString(),
    snapshotDate: u.snapshotDate,
    rowCountTotal: u.rowCountTotal,
    rowCountMatched: u.rowCountMatched,
    status: u.status,
  }));

  res.json(result);
});

// POST /uploads/parse — parse file, return preview + auto-detect distributor
router.post("/uploads/parse", requireAuth, upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const headerRowIndex = Number(req.body.headerRowIndex ?? 0);
  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  let columns: string[] = [];
  let rows: Record<string, string>[] = [];
  let detectedDelimiter: string | null = null;

  if (ext === ".xlsx" || ext === ".xls") {
    ({ columns, rows } = await parseXlsx(filePath, headerRowIndex));
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const firstLine = content.split(/\r?\n/)[headerRowIndex] ?? "";
    detectedDelimiter = req.body.delimiter ?? sniffDelimiter(firstLine);
    ({ columns, rows } = parseDelimited(content, detectedDelimiter as string, headerRowIndex));
  }

  const rowCountTotal = rows.length;
  const tempFileKey = path.basename(filePath);

  // Auto-detect distributor from columns (or use explicit distributorId if provided)
  const explicitDistributorId = req.body.distributorId ? Number(req.body.distributorId) : null;
  const detection = await detectDistributor(columns);
  const resolvedDistributorId = explicitDistributorId ?? detection.distributorId;

  // Check saved profile for the resolved distributor
  const [profile] = resolvedDistributorId
    ? await db.select().from(importProfilesTable).where(eq(importProfilesTable.distributorId, resolvedDistributorId))
    : [];

  // Effective mapping: saved profile > fingerprint detection > null
  const effectiveMapping = (profile?.mapping ?? detection.mapping) as Record<string, string | null> | null;

  // Apply brand filter for row count estimate
  let rowCountMatched = rowCountTotal;
  if (effectiveMapping?.brand) {
    const brandMap = await buildBrandMap();
    rowCountMatched = rows.filter((r) => {
      const raw = r[effectiveMapping.brand as string] ?? "";
      return resolveCanonicalBrand(raw, brandMap) !== null;
    }).length;
  }

  res.json({
    tempFileKey,
    columns,
    rows: rows.slice(0, 50),
    rowCountTotal,
    rowCountMatched,
    hasProfile: !!profile,
    detectedDelimiter,
    detectedDistributorId: detection.distributorId,
    detectedDistributorName: detection.distributorName,
    detectedMapping: profile ? null : detection.mapping,
    profile: profile
      ? {
          id: profile.id,
          distributorId: profile.distributorId,
          sourceFormat: profile.sourceFormat,
          delimiter: profile.delimiter ?? null,
          headerRowIndex: profile.headerRowIndex,
          mapping: profile.mapping,
          createdAt: profile.createdAt.toISOString(),
          updatedAt: profile.updatedAt.toISOString(),
        }
      : null,
  });
});

// POST /uploads/commit — commit parsed upload as a snapshot
router.post("/uploads/commit", requireAuth, async (req, res): Promise<void> => {
  const { distributorId, tempFileKey, mapping, sourceFormat, delimiter, headerRowIndex = 0, snapshotDate, saveProfile = false } = req.body;

  if (!distributorId || !tempFileKey || !mapping) {
    res.status(400).json({ error: "distributorId, tempFileKey, and mapping are required" });
    return;
  }

  const filePath = path.join(uploadsDir, tempFileKey);
  if (!fs.existsSync(filePath)) {
    res.status(400).json({ error: "Temp file not found — upload again" });
    return;
  }

  const ext = path.extname(tempFileKey).toLowerCase();
  const actualExt = ext.replace(/^\d+-/, "").includes("xlsx") ? ".xlsx" : ext;

  let rows: Record<string, string>[] = [];

  if (actualExt === ".xlsx" || sourceFormat === "xlsx") {
    ({ rows } = await parseXlsx(filePath, headerRowIndex));
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const delim = delimiter === "tab" ? "\t" : delimiter === "pipe" ? "|" : delimiter ?? "\t";
    ({ rows } = parseDelimited(content, delim, headerRowIndex));
  }

  const rowCountTotal = rows.length;
  const brandMap = await buildBrandMap();

  const today = new Date().toISOString().split("T")[0];
  const effectiveSnapshotDate = snapshotDate ?? today;

  // Create upload record
  const [uploadRecord] = await db
    .insert(uploadsTable)
    .values({
      distributorId: Number(distributorId),
      filename: tempFileKey.replace(/^\d+-/, ""),
      snapshotDate: effectiveSnapshotDate,
      rowCountTotal,
      rowCountMatched: 0,
      uploadedBy: req.session.userId,
      status: "parsing",
    })
    .returning();

  let committed = 0;

  for (const row of rows) {
    const rawVpn = row[mapping.vpn] ?? "";
    const rawBrand = row[mapping.brand] ?? "";
    const rawDescription = row[mapping.description] ?? "";
    const rawPrice = row[mapping.sell_price] ?? "";
    const rawSoh = row[mapping.soh] ?? "";
    const rawSoo = mapping.soo ? (row[mapping.soo] ?? "") : "";

    if (!rawVpn.trim()) continue;

    const canonicalBrand = resolveCanonicalBrand(rawBrand, brandMap);
    if (!canonicalBrand) continue;

    const vpnNormalized = normalizeVpn(rawVpn);
    const sellPrice = parseFloat(rawPrice.replace(/[^0-9.-]/g, "")) || null;
    const soh = rawSoh ? parseInt(rawSoh.replace(/[^0-9]/g, ""), 10) || null : null;
    const soo = rawSoo ? parseInt(rawSoo.replace(/[^0-9]/g, ""), 10) || null : null;

    // Upsert product
    const existing = await db.select().from(productsTable).where(eq(productsTable.vpnNormalized, vpnNormalized)).limit(1);

    let productId: number;
    if (existing.length > 0) {
      const p = existing[0];
      // Flag brand conflict — keep first brand
      if (p.brand !== canonicalBrand) {
        req.log.warn({ vpn: vpnNormalized, existingBrand: p.brand, newBrand: canonicalBrand }, "Brand conflict on VPN — keeping original");
      }
      await db.update(productsTable).set({
        description: rawDescription || p.description,
        lastSeenAt: new Date(),
      }).where(eq(productsTable.id, p.id));
      productId = p.id;
    } else {
      const [newProduct] = await db.insert(productsTable).values({
        vpnNormalized,
        vpnDisplay: rawVpn.trim(),
        brand: canonicalBrand,
        description: rawDescription,
      }).returning();
      productId = newProduct.id;
    }

    // Insert snapshot
    await db.insert(stockSnapshotsTable).values({
      uploadId: uploadRecord.id,
      distributorId: Number(distributorId),
      productId,
      snapshotDate: effectiveSnapshotDate,
      sellPrice: sellPrice != null ? String(sellPrice) : null,
      soh,
      soo: soo ?? null,
    });

    committed++;
  }

  // Update upload record
  await db.update(uploadsTable).set({
    rowCountMatched: committed,
    status: "committed",
  }).where(eq(uploadsTable.id, uploadRecord.id));

  // Save profile if requested — only if mapping has all required fields populated
  const mappingIsValid = !!(mapping.vpn && mapping.brand && mapping.sell_price && mapping.soh);
  if (saveProfile && mappingIsValid) {
    const delimitedFormat = sourceFormat === "xlsx" ? null : (delimiter ?? null);
    await db
      .insert(importProfilesTable)
      .values({
        distributorId: Number(distributorId),
        sourceFormat,
        delimiter: delimitedFormat,
        headerRowIndex: Number(headerRowIndex),
        mapping,
      })
      .onConflictDoUpdate({
        target: importProfilesTable.distributorId,
        set: {
          sourceFormat,
          delimiter: delimitedFormat,
          headerRowIndex: Number(headerRowIndex),
          mapping,
          updatedAt: new Date(),
        },
      });
  }

  res.status(201).json({
    id: uploadRecord.id,
    distributorId: Number(distributorId),
    distributorName: "",
    filename: tempFileKey.replace(/^\d+-/, ""),
    uploadedAt: uploadRecord.uploadedAt.toISOString(),
    snapshotDate: effectiveSnapshotDate,
    rowCountTotal,
    rowCountMatched: committed,
    status: "committed",
  });
});

// Import Profile endpoints
router.get("/distributors/:id/profile", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [profile] = await db.select().from(importProfilesTable).where(eq(importProfilesTable.distributorId, id));
  if (!profile) {
    res.status(404).json({ error: "No profile for this distributor" });
    return;
  }
  res.json({
    id: profile.id,
    distributorId: profile.distributorId,
    sourceFormat: profile.sourceFormat,
    delimiter: profile.delimiter ?? null,
    headerRowIndex: profile.headerRowIndex,
    mapping: profile.mapping,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  });
});

router.put("/distributors/:id/profile", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { sourceFormat, delimiter, headerRowIndex = 0, mapping } = req.body;

  if (!sourceFormat || !mapping) {
    res.status(400).json({ error: "sourceFormat and mapping are required" });
    return;
  }

  const [profile] = await db
    .insert(importProfilesTable)
    .values({ distributorId: id, sourceFormat, delimiter: delimiter ?? null, headerRowIndex, mapping })
    .onConflictDoUpdate({
      target: importProfilesTable.distributorId,
      set: { sourceFormat, delimiter: delimiter ?? null, headerRowIndex, mapping, updatedAt: new Date() },
    })
    .returning();

  res.json({
    id: profile.id,
    distributorId: profile.distributorId,
    sourceFormat: profile.sourceFormat,
    delimiter: profile.delimiter ?? null,
    headerRowIndex: profile.headerRowIndex,
    mapping: profile.mapping,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  });
});

export default router;
