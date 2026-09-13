/**
 * ClaimCheck India — Backend Server
 * -----------------------------------
 * Express server that:
 *  - Serves the frontend (public/)
 *  - Looks up product data from Open Food Facts (GTIN or product-page link)
 *  - Accepts uploaded label images (front/ingredients/nutrition) as evidence
 *  - Runs the FSSAI-rule evidence engine (rules/claimRules.json) against
 *    manually entered, extracted, or OCR-corrected nutrition data
 *  - Returns a Supported / Contradicted / Insufficient Evidence verdict
 *    together with the evidence, calculation, and rule that was applied.
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Setup ----------
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname || "")}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per image
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image uploads are allowed."));
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "rules", "claimRules.json"), "utf-8"));
const ruleById = Object.fromEntries(rules.claims.map(c => [c.id, c]));

// ---------- Helpers ----------

/** Safely evaluate a small arithmetic/boolean formula string against a data object. */
function evalFormula(formula, data) {
  const keys = Object.keys(data);
  const values = keys.map(k => data[k]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `"use strict"; return ( ${formula} );`);
  return fn(...values);
}

/** Determine whether all required fields for a claim are present and numeric/non-empty. */
function findMissingFields(claim, product) {
  const missing = [];
  for (const field of claim.requiredFields) {
    const val = product[field];
    if (val === undefined || val === null || val === "") {
      missing.push(field);
    } else if (field !== "physicalState" && field !== "ingredientsText" && isNaN(Number(val))) {
      missing.push(field);
    }
  }
  return missing;
}

/** Core rule engine: returns { verdict, calculation, missing } */
function evaluateClaim(claim, product) {
  const missing = findMissingFields(claim, product);
  if (missing.length > 0) {
    return {
      verdict: "Insufficient Evidence",
      calculation: [`Missing required data: ${missing.join(", ")}`],
      details: null
    };
  }

  const numericProduct = { ...product };
  for (const key of Object.keys(numericProduct)) {
    if (key !== "physicalState" && key !== "ingredientsText" && numericProduct[key] !== undefined) {
      const n = Number(numericProduct[key]);
      if (!isNaN(n)) numericProduct[key] = n;
    }
  }

  const rule = claim.rule;
  const calculation = [];

  if (rule.type === "ingredient_absence") {
    const text = String(product.ingredientsText || "").toLowerCase();
    const found = rule.bannedKeywords.filter(kw => text.includes(kw.toLowerCase()));
    if (found.length > 0) {
      calculation.push(`Ingredient list contains: ${found.join(", ")}`);
      return { verdict: "Contradicted", calculation, details: { matchedKeywords: found } };
    }
    calculation.push("No sugar/sweetener keywords found in ingredient list.");
    return { verdict: "Supported", calculation, details: { matchedKeywords: [] } };
  }

  if (rule.type === "threshold_any_of") {
    for (const cond of rule.conditions) {
      let applicable = true;
      try {
        const result = evalFormula(cond.formula, numericProduct);
        if (result === true) {
          calculation.push(`PASS — ${cond.explanation} (formula: ${cond.formula})`);
          return { verdict: "Supported", calculation, details: { conditionUsed: cond.explanation } };
        } else if (result !== false) {
          applicable = false;
        }
      } catch (e) {
        applicable = false;
      }
      if (applicable) {
        calculation.push(`FAIL — ${cond.explanation} (formula: ${cond.formula})`);
      }
    }
    return { verdict: "Contradicted", calculation, details: null };
  }

  if (rule.type === "threshold_all_of") {
    let allPass = true;
    for (const cond of rule.conditions) {
      const result = evalFormula(cond.formula, numericProduct);
      calculation.push(`${result ? "PASS" : "FAIL"} — ${cond.explanation} (formula: ${cond.formula})`);
      if (!result) allPass = false;
    }
    return { verdict: allPass ? "Supported" : "Contradicted", calculation, details: null };
  }

  if (rule.type === "comparative_increase" || rule.type === "comparative_decrease") {
    const result = evalFormula(rule.formula, numericProduct);
    calculation.push(`${rule.explanation} (formula: ${rule.formula})`);
    calculation.push(result ? "PASS" : "FAIL");
    return { verdict: result ? "Supported" : "Contradicted", calculation, details: null };
  }

  return { verdict: "Insufficient Evidence", calculation: ["Unrecognized rule type."], details: null };
}

/**
 * Determine whether a product is "solid" or "liquid" for threshold purposes.
 * Open Food Facts nests almost all packaged foods (including solids like
 * noodles) under a generic parent category tag containing the word
 * "beverages" (e.g. "Plant-based foods and beverages"), so a naive substring
 * match on that word misclassifies solids as liquids. This uses the pack
 * quantity unit as the primary signal, and only falls back to specific
 * liquid *leaf* category tags (not generic parent tags) when quantity is
 * absent or ambiguous.
 */
function determinePhysicalState(offProduct) {
  const quantity = (offProduct.quantity || "").toLowerCase();
  const categories = (offProduct.categories_tags || []).map(c => String(c).toLowerCase());

  // Primary signal: explicit unit in the pack quantity string.
  if (/\d\s*(ml|millilit)/i.test(quantity)) return "liquid";
  if (/\d\s*(g|gram|kg)\b/i.test(quantity)) return "solid";
  if (/\d\s*l\b/i.test(quantity) && !/\d\s*lb\b/i.test(quantity)) return "liquid";

  // Secondary signal: specific liquid *leaf* categories only — never the
  // generic "...and beverages" parent tag, which nearly every product has.
  const liquidLeafTags = [
    "en:milks", "en:plant-milks", "en:fruit-juices", "en:vegetable-juices",
    "en:sodas", "en:waters", "en:teas", "en:coffees", "en:beers", "en:wines",
    "en:smoothies", "en:hot-beverages", "en:cold-beverages", "en:energy-drinks",
    "en:milkshakes", "en:nectars", "en:flavoured-milks"
  ];
  if (categories.some(c => liquidLeafTags.includes(c))) return "liquid";

  return "solid"; // safer default for a claims checker — most packaged foods are solid
}

/** Map an Open Food Facts product payload into our internal nutrition schema (per 100g/100ml). */
function mapOffProductToSchema(offProduct) {
  const n = offProduct.nutriments || {};

  return {
    productName: offProduct.product_name || offProduct.generic_name || "Unknown product",
    brand: offProduct.brands || "",
    gtin: offProduct.code || "",
    imageUrl: offProduct.image_front_url || offProduct.image_url || "",
    physicalState: determinePhysicalState(offProduct),
    energy_kcal_100g: n["energy-kcal_100g"] ?? n["energy-kcal"] ?? "",
    protein_100g: n["proteins_100g"] ?? "",
    fat_100g: n["fat_100g"] ?? "",
    saturatedFat_100g: n["saturated-fat_100g"] ?? "",
    transFat_100g: n["trans-fat_100g"] ?? "",
    sugar_100g: n["sugars_100g"] ?? "",
    fiber_100g: n["fiber_100g"] ?? "",
    sodium_100g: n["sodium_100g"] != null ? Number(n["sodium_100g"]) * 1000 : "", // g -> mg
    cholesterol_100g: n["cholesterol_100g"] != null ? Number(n["cholesterol_100g"]) * 1000 : "", // g -> mg
    ingredientsText: offProduct.ingredients_text_en || offProduct.ingredients_text || "",
    source: "Open Food Facts"
  };
}

// ---------- Routes ----------

// List all supported claims + their rules (for the frontend claim picker)
app.get("/api/rules", (_req, res) => {
  res.json(rules);
});

// Look up a product by GTIN via Open Food Facts
app.get("/api/product/gtin/:gtin", async (req, res) => {
  const { gtin } = req.params;
  try {
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(gtin)}.json`);
    const offData = await offRes.json();
    if (!offData || offData.status !== 1 || !offData.product) {
      return res.status(404).json({ error: "Product not found in Open Food Facts.", gtin });
    }
    res.json({ product: mapOffProductToSchema(offData.product), raw_status: offData.status });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Open Food Facts API.", detail: String(err) });
  }
});

// Look up a product by pasting an Open Food Facts product-page URL
app.post("/api/product/off-link", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body." });
  const match = String(url).match(/(\d{8,14})/); // GTIN/barcode embedded in the OFF URL
  if (!match) return res.status(400).json({ error: "Could not find a barcode/GTIN in the provided link." });
  const gtin = match[1];
  try {
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(gtin)}.json`);
    const offData = await offRes.json();
    if (!offData || offData.status !== 1 || !offData.product) {
      return res.status(404).json({ error: "Product not found in Open Food Facts.", gtin });
    }
    res.json({ product: mapOffProductToSchema(offData.product), raw_status: offData.status });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Open Food Facts API.", detail: String(err) });
  }
});

// Upload label images (front / ingredients / nutrition) — used as evidence, and for client-side OCR
app.post("/api/upload-labels", upload.array("images", 5), (req, res) => {
  const files = (req.files || []).map(f => ({
    fieldname: f.fieldname,
    filename: f.filename,
    url: `/uploads/${f.filename}`,
    size: f.size
  }));
  res.json({ files });
});

// Run the rule engine against a claim + product evidence
app.post("/api/verify", (req, res) => {
  const { claimId, product, referenceProduct, evidenceImages } = req.body || {};
  const claim = ruleById[claimId];
  if (!claim) return res.status(400).json({ error: `Unknown claim id: ${claimId}` });
  if (!product || typeof product !== "object") {
    return res.status(400).json({ error: "Missing 'product' evidence object." });
  }

  // Merge in reference-product fields for comparative claims
  const mergedProduct = { ...product };
  if (referenceProduct) {
    if (referenceProduct.protein_100g !== undefined) mergedProduct.reference_protein_100g = referenceProduct.protein_100g;
    if (referenceProduct.sodium_100g !== undefined) mergedProduct.reference_sodium_100g = referenceProduct.sodium_100g;
  }

  const result = evaluateClaim(claim, mergedProduct);

  res.json({
    claim: { id: claim.id, label: claim.label, description: claim.description, category: claim.category },
    verdict: result.verdict,
    calculation: result.calculation,
    details: result.details,
    evidenceUsed: mergedProduct,
    evidenceImages: evidenceImages || [],
    ruleReference: {
      source: rules.meta.source,
      reference_url: rules.meta.reference_url,
      compendium_url: rules.meta.compendium_url,
      disclaimer: rules.meta.disclaimer
    },
    generatedAt: new Date().toISOString()
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, claimsLoaded: rules.claims.length }));

app.listen(PORT, () => {
  console.log(`ClaimCheck India server running at http://localhost:${PORT}`);
});
