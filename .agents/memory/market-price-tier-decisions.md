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

## Dell Pro 7 = MAINSTREAM (corrected from earlier wrong assumption)

`/\bdell\s+pro\s*7\b/i` in the mainstream block. "DELL PRO 7 NOTEBOOK, 13/14\" FHD+IR, U5-335/U7-365, W11P(CP+) 3Y PRO" is $2,999+ — priced above Pro 5 mainstream ($2,369). Earlier assumption of "value" was wrong. Pattern requires "DELL" immediately before "PRO 7" so keyboards (DELL KB526 PRO 5) and old desktops (DELL PRO 7500) do not misfire.

## Distributor descriptions omit brand prefixes — always query real DB descriptions for new tests

Confirmed pattern: some distributors store "LENOVO X1 CARBON G13 AURA U7-268V VPRO…" without the "THINKPAD" prefix. The existing `/thinkpad\s+x1\b/i` pattern couldn't match it. Fix: added `/\bx1\s+carbon\b/i`, `/\bx1\s+yoga\b/i`, `/\bx9\s+aura\b/i` as peer patterns to cover the bare form. ThinkPad T-series (T14/T14S stored as "LENOVO T14 G6…") has the same gap — tracked as task #35. **Rule:** before writing tier-map tests, always query the DB for the real stored description string and test against that; idealised descriptions (with proper brand prefix) are kept but labelled separately.

## Coverage diagnostic findings — client-hardware-only (Aug 2026)

After adding bare-form patterns (T-series, L-series, ZBook) and Dell Pro 3/5/Essential:
- LENOVO 25.4% matched (368/1450 HW rows) — remaining unmatched are AIO desktops (M90A), ThinkCentre, ThinkPad P-series (workstation), and warranty descriptions that passed the HW filter via "MAINSTREAM"/"NOTEBOOK" tokens.
- HP 3.6% matched (138/3814) — misleadingly low: HP care packs include the word "NOTEBOOK" so they pass the HW filter; actual commercial notebook lines (EliteBook, ProBook, ZBook) ARE covered by patterns. Residual are service/FRU items that can't be candidates in the pipeline.
- DELL 59.6% matched (189/317 client HW rows) — up from 24.6%. Remaining 40% unmatched are server SSDs/CPUs/memory/GPUs that pass the GB-token HW filter but can never be candidates in a client-hardware comparison. All actual Dell Pro commercial notebooks and desktops are now matched. Dell Pro 3/5/7/Essential hardware uses CTO/BTO/BTP VPN prefixes with sku_type=StockedItem — they ARE candidates.
- MICROSOFT 90.6% (347/383) — Surface Laptop/Pro well covered; 36 unmatched are FRU repair parts.
- ASUS 1.2% — only NUC mini PCs and gaming motherboards; no commercial ExpertBook laptops in catalogue.

Real actionable hardware gaps for future work: Lenovo ThinkPad P-series (workstation, mainstream/flagship), Lenovo M90A AIO (ThinkCentre AIO, mainstream), Dell Pro 24 AIO Plus (mainstream).

## SYSTEM_PROMPT and FAMILY_TIER_MAP must stay in sync

Both surfaces encode the same tier map. When one changes, the other must change in lockstep. The code guard (`applyDeterministicGuard`) only fires for FAMILY_TIER_MAP entries; the prompt only fires for entries in the SYSTEM_PROMPT text. A mismatch means the guard can't backstop model errors for that family.

## brand-tiers e2e test — partialMatch required

The brand-tiers comparison tests search by the `UNIQUE` prefix (e.g. `test_tier_1234`), but product VPNs are `test_tier_1234-CORE-VPN`. Without `&partialMatch=true`, the ILIKE is exact-match and always returns `[]`. Always include `partialMatch=true` in comparison endpoint calls within this test file.
