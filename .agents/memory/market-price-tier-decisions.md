---
name: Market Price tier decisions
description: Confirmed product-family tier placements for the SYSTEM_PROMPT and FAMILY_TIER_MAP — business decisions that override intuition or naming.
---

## EliteBook X is FLAGSHIP

`HP EliteBook X` is **flagship** tier (same as EliteBook Ultra, X1 Carbon, Dragonfly) — **not** mainstream commercial despite sitting alongside EliteBook 6/8 in some HP line-up listings.

**Why:** Confirmed by Jay. The "X" suffix marks HP's premium consumer-crossover commercial line, priced and positioned above EliteBook 6/8. In the code FAMILY_TIER_MAP, `/elitebook\s+x\b/i` sits in the flagship block immediately after `/elitebook\s+ultra/i`.

**How to apply:** Any future tier-map edit must keep EliteBook X in flagship. The unit test `"demotes EliteBook X from close → partial (flagship vs mainstream)"` in `market-price-llm.test.ts` will fail if it accidentally moves to mainstream — treat that as a regression guard.

## Adopted configuration: SIMPLE prompt + full deterministic guard

`MARKET_PRICE_PROMPT` defaults to `"simple"`. `SYSTEM_PROMPT_STRICT` stays in the file unused (revert via env var). `applyDeterministicGuard` runs with full tier logic active — no `skipTierGuard`. Per-brand result cap of 4 applied after the guard.

**Why:** A/B experiment showed STRICT collapsed to copy-pasted reasons on homogeneous pools (SFF: 6/8 reasons identical). SIMPLE produced specific reasons and better brand spread. Guard backstops SIMPLE's tier blind spots (e.g. EliteBook X vs mainstream source demoted in code regardless of model output).

**How to apply:** The `MARKET_PRICE_PROMPT=strict` env var switches to the strict rulebook without code change. Do not re-enable `skipTierGuard` in the route — it was a temporary A/B flag.

## Dell 2026 commercial ladder (web-verified, Jay confirmed)

Numbers replaced Base/Plus/Premium labels. Use product-line NAME not price — high-config Pro 7 can exceed low-config Premium.

| Line | Tier | Notes |
|---|---|---|
| Pro 3 | value | replaces Pro Base / Latitude 3xxx |
| Pro 5 | mainstream | replaces Pro Plus / Latitude 5xxx |
| Pro 7 | mainstream | upper-mainstream; competes with T14s/X13/EliteBook 8; revival of Latitude 7000 |
| Pro Premium | flagship | unchanged |
| Pro Max / Pro Max Premium | flagship | mobile workstation |
| Pro Precision 5/7 | flagship | coming soon — replaces Pro Max |
| Pro Plus (legacy) | mainstream | |
| Pro Base / Pro E / Pro ESS (legacy) | value | |

FAMILY_TIER_MAP patterns: `/\bdell\s+pro\s*3\b/i` (value), `/\bdell\s+pro\s*5\b/i` (mainstream), `/\bdell\s+pro\s*7\b/i` (mainstream — requires DELL before PRO 7 so "DELL PRO 7500" misfire is blocked by word boundary on 7), `/\bpro\s+precision\s*[57]\b/i` (flagship).

## Distributor descriptions omit brand prefixes — always query real DB descriptions for new tests

Confirmed pattern: some distributors store "LENOVO X1 CARBON G13 AURA U7-268V VPRO…" without the "THINKPAD" prefix. The existing `/thinkpad\s+x1\b/i` pattern couldn't match it. Fix: added `/\bx1\s+carbon\b/i`, `/\bx1\s+yoga\b/i`, `/\bx9\s+aura\b/i` as peer patterns to cover the bare form. ThinkPad T-series (T14/T14S stored as "LENOVO T14 G6…") has the same gap — tracked as task #35. **Rule:** before writing tier-map tests, always query the DB for the real stored description string and test against that; idealised descriptions (with proper brand prefix) are kept but labelled separately.

## Coverage diagnostic findings — client-hardware-only (Aug 2026)

After adding bare-form patterns (T-series, L-series, ZBook) and Dell Pro 3/5/Essential:
- LENOVO 25.4% matched (368/1450 HW rows) — remaining unmatched are AIO desktops (M90A), ThinkCentre, ThinkPad P-series (workstation), and warranty descriptions that passed the HW filter via "MAINSTREAM"/"NOTEBOOK" tokens.
- HP 3.6% matched (138/3814) — misleadingly low: HP care packs include the word "NOTEBOOK" so they pass the HW filter; actual commercial notebook lines (EliteBook, ProBook, ZBook) ARE covered by patterns. Residual are service/FRU items that can't be candidates in the pipeline.
- DELL 59.6% matched (189/317 client HW rows) — up from 24.6%. Remaining 40% unmatched are server SSDs/CPUs/memory/GPUs that pass the GB-token HW filter but can never be candidates in a client-hardware comparison. All actual Dell Pro commercial notebooks and desktops are now matched.

## HP EliteBook 6xx/8xx pattern fix

Old patterns `/elitebook\s+6\b/i` and `/elitebook\s+8\b/i` only matched bare "6" / "8" at word boundary — BUT real stored descriptions are "ELITEBOOK 640 G11", "ELITEBOOK 860 G11" (three-digit model numbers), where the digit is NOT at a word boundary. Fixed to `/elitebook\s+6\d{2}\b/i` and `/elitebook\s+8\d{2}\b/i`. This also affects Pro 7 tier-guard: EliteBook 6xx/8xx are now correctly mainstream peers.
- MICROSOFT 90.6% (347/383) — Surface Laptop/Pro well covered; 36 unmatched are FRU repair parts.
- ASUS 1.2% — only NUC mini PCs and gaming motherboards; no commercial ExpertBook laptops in catalogue.

Real actionable hardware gaps for future work: Lenovo ThinkPad P-series (workstation, mainstream/flagship), Lenovo M90A AIO (ThinkCentre AIO, mainstream), Dell Pro 24 AIO Plus (mainstream).

## SYSTEM_PROMPT and FAMILY_TIER_MAP must stay in sync

Both surfaces encode the same tier map. When one changes, the other must change in lockstep. The code guard (`applyDeterministicGuard`) only fires for FAMILY_TIER_MAP entries; the prompt only fires for entries in the SYSTEM_PROMPT text. A mismatch means the guard can't backstop model errors for that family.

## brand-tiers e2e test — partialMatch required

The brand-tiers comparison tests search by the `UNIQUE` prefix (e.g. `test_tier_1234`), but product VPNs are `test_tier_1234-CORE-VPN`. Without `&partialMatch=true`, the ILIKE is exact-match and always returns `[]`. Always include `partialMatch=true` in comparison endpoint calls within this test file.
