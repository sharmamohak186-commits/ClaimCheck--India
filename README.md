# ClaimCheck India — Complete Prototype

Evidence-first verification tool for packaged-food nutrition/comparative
claims in India. Checks a claim (e.g. "High Protein") against a product's
real nutrition data and a codified FSSAI-reference rules engine, and returns
**Supported / Contradicted / Insufficient Evidence** with the full evidence
trail, calculation, and rule applied.

> This is an academic prototype, not a legal certification system. Rule
> thresholds must be re-verified against the latest official FSSAI
> notification before any real-world use — see `rules/claimRules.json`.

## What's included

- **Full Node.js/Express backend** (`server.js`) with a real, working REST API
- **JSON-driven rules engine** covering 15 FSSAI-style claims (expanded from
  the original 5), each with explicit formulas and explanations
- **Open Food Facts integration** — GTIN lookup and product-page-link lookup
- **Browser barcode scanning** via Quagga2 (camera access)
- **Browser OCR** via Tesseract.js for label photos, with a lightweight
  nutrient-extraction heuristic and a mandatory human-review step
- **Manual entry** for any/all fields, always editable regardless of source
- **Image evidence storage** — uploaded label photos are saved and shown
  alongside the verdict
- **A distinct "Inspection Ledger" UI** — dark scanning-desk workspace,
  paper evidence cards, rubber-stamp verdicts, monospace calculation trace

## Project structure

```
claimcheck-india/
├── package.json
├── server.js                 # Express API: lookup, upload, verify
├── rules/
│   └── claimRules.json       # FSSAI rule definitions (15 claims)
└── public/
    ├── index.html
    ├── css/style.css
    ├── js/app.js
    └── uploads/               # uploaded label images land here
```

## Run locally

1. Install Node.js (LTS, v16+).
2. Open a terminal in this folder.
3. Run:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000

No API key is required — Open Food Facts' public API is used directly.

## How the pieces fit together

```
GTIN / barcode scan / OFF link / label photos / manual input
        │
        ▼
  product/evidence extraction  (Open Food Facts API, Quagga2, Tesseract.js)
        │
        ▼
  claim selection  (15 FSSAI-style claims, incl. comparative claims)
        │
        ▼
  rule selection   (rules/claimRules.json — thresholds, formulas)
        │
        ▼
  calculation      (server-side rule engine, POST /api/verify)
        │
        ▼
  verdict           Supported / Contradicted / Insufficient Evidence
        │
        ▼
  evidence + explanation + FSSAI reference + uploaded images
```

## API reference

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/rules` | Returns all claim definitions + FSSAI reference metadata |
| `GET` | `/api/product/gtin/:gtin` | Look up a product on Open Food Facts by GTIN/barcode |
| `POST` | `/api/product/off-link` | Look up a product by pasting an Open Food Facts page URL |
| `POST` | `/api/upload-labels` | Upload up to 5 label images (multipart, field name `images`) |
| `POST` | `/api/verify` | Run the rule engine: `{ claimId, product, referenceProduct?, evidenceImages? }` → verdict |
| `GET` | `/api/health` | Basic health check |

### Example `/api/verify` request

```json
{
  "claimId": "high_protein",
  "product": {
    "physicalState": "solid",
    "energy_kcal_100g": 380,
    "protein_100g": 22
  }
}
```

### Example response

```json
{
  "claim": { "id": "high_protein", "label": "High Protein", "category": "nutrient_content" },
  "verdict": "Supported",
  "calculation": [
    "PASS — Solid food: protein >= 10g per 100g. (formula: physicalState == 'solid' && protein_100g >= 10)"
  ],
  "evidenceUsed": { "physicalState": "solid", "energy_kcal_100g": 380, "protein_100g": 22 },
  "ruleReference": {
    "source": "FSSAI (Food Safety and Standards Authority of India) Advertising & Claims Regulations, 2018...",
    "reference_url": "https://www.fssai.gov.in/food-law/regulations",
    "compendium_url": "https://www.fssai.gov.in/upload/uploadfiles/files/Compendium_Advertising_Claims_Regulations_04_10_2022.pdf"
  }
}
```

## Supported claims (15)

| Claim | Type |
|---|---|
| High Protein | nutrient content |
| Low Fat | nutrient content |
| No Added Sugar | ingredient-based |
| 30% More Protein | comparative (needs reference product) |
| Reduced Sodium | comparative (needs reference product) |
| Low Sodium | nutrient content |
| Sodium Free | nutrient content |
| Low Sugar | nutrient content |
| Sugar Free | nutrient content |
| Fat Free | nutrient content |
| Zero Trans Fat | nutrient content |
| Source of Fiber | nutrient content |
| High Fiber | nutrient content |
| Low Calorie | nutrient content |
| Cholesterol Free | nutrient content |

Each rule's exact formula, explanation, and required fields live in
`rules/claimRules.json` — edit that file to add claims or update thresholds
without touching any code.

## Demo GTINs

These are illustrative and depend on what is present in Open Food Facts —
if a demo code isn't found, the app returns "product not found" and you can
switch to Manual entry.

- `8901234567890` — high-protein demo
- `8901234567891` — low-fat demo
- `8901234567892` — reduced-sodium demo

## Important notes on the "evidence-first" design

- If required nutrition/ingredient/reference data is missing for a selected
  claim, the engine returns **Insufficient Evidence** instead of guessing.
- OCR and barcode scanning depend on the browser's camera/internet access.
  OCR output is always shown for human review before it's trusted — image
  quality and label layout vary, and OCR is best-effort only.
- Comparative claims ("30% More Protein", "Reduced Sodium") require a
  reference/comparator product value, entered manually in the reference box
  that appears when you select one of those claims.

## Where to take this for a production system

See the improvement areas discussed earlier in this project's write-up:
expanding claim coverage, authoritative Indian product data, database-backed
rules with versioning, confidence scoring, audit trails, multi-language UI,
and legal/regulatory partnership before any real-world deployment.

## FSSAI references

- https://www.fssai.gov.in/food-law/regulations
- https://www.fssai.gov.in/upload/uploadfiles/files/Compendium_Advertising_Claims_Regulations_04_10_2022.pdf
