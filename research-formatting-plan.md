---
date: 2025-01-27T00:00:00Z
project: navi-whisper-lux
branch: main
based_on_research: Research findings on /research page formatting issues
status: ready_for_review
---

## Implementation Plan: Fix /research Text Formatting

### Objective
Fix text formatting issues on the `/research` page:
1. Remove random `<p>` tags used for labels and convert to proper semantic elements
2. Move section headings into chart components (like Cursor's report style)
3. Update fonts to use Inter instead of Geist for better readability and Cursor-like aesthetic

### Research Summary
Found that labels like "Research Report – July 2025", "By Andy Prevalsky", and benchmark labels are incorrectly using `<p>` tags. Headings are duplicated between parent page and chart components. Font is currently Geist but Inter is already loaded and better matches Cursor's research aesthetic.

### Scope
- **Files to modify**: 
  - `front-end/src/pages/Research.tsx`
  - `front-end/src/components/research/PerformanceChart.tsx`
  - `front-end/src/components/research/CostComparisonChart.tsx`
  - `front-end/src/components/research/AccuracyOverTimeChart.tsx`
  - `front-end/src/index.css`
- **New files to create**: None
- **Components affected**: Research page and all three chart components

### Changes

#### Phase 1: Fix Random `<p>` Tags in Research.tsx

##### Change 1.1: Convert date label from `<p>` to `<span>`
- **File**: `front-end/src/pages/Research.tsx:30-32`
- **Description**: Change "Research Report – July 2025" label from `<p>` to `<span>` for proper semantics
- **Current code**:
```tsx
<p className="text-xs font-semibold tracking-[0.4em] uppercase text-slate-400">
  Research Report – July 2025
</p>
```
- **Proposed change**: Replace `<p>` with `<span>` (same styling)
- **Dependencies**: None
- **Testing approach**: Visual verification that styling remains identical

##### Change 1.2: Convert author attribution from `<p>` to `<span>`
- **File**: `front-end/src/pages/Research.tsx:41-43`
- **Description**: Change "By Andy Prevalsky · July 2025" from `<p>` to `<span>` for proper semantics
- **Current code**:
```tsx
<p className="text-sm text-slate-500 font-medium">
  By Andy Prevalsky · July 2025
</p>
```
- **Proposed change**: Replace `<p>` with `<span>` (same styling)
- **Dependencies**: None
- **Testing approach**: Visual verification that styling remains identical

##### Change 1.3: Convert "Mission" label from `<p>` to `<span>`
- **File**: `front-end/src/pages/Research.tsx:47-49`
- **Description**: Change "Mission" section label from `<p>` to `<span>` for proper semantics
- **Current code**:
```tsx
<p className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400">
  Mission
</p>
```
- **Proposed change**: Replace `<p>` with `<span>` (same styling)
- **Dependencies**: None
- **Testing approach**: Visual verification that styling remains identical

#### Phase 2: Move Headings into Chart Components

##### Change 2.1: Remove duplicate headings from Research.tsx for Benchmark 01
- **File**: `front-end/src/pages/Research.tsx:85-93`
- **Description**: Remove the duplicate "Benchmark 01 — SWE Bench" label and heading that appears above PerformanceChart, since PerformanceChart already has headings inside
- **Current code**:
```tsx
<section className="space-y-5">
  <p className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400">
    Benchmark 01 — SWE Bench
  </p>
  <h2 className="text-3xl font-semibold">Rose-1 leads on intelligence and speed</h2>
  <p className="text-lg text-slate-700 leading-relaxed">
    Following Cursor's SWE Bench framing...
  </p>
  <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
    <PerformanceChart />
  </div>
  ...
</section>
```
- **Proposed change**: Remove the `<p>` label and `<h2>` heading, keep only the description paragraph and chart wrapper. Update PerformanceChart to include "Benchmark 01 — SWE Bench" label inside.
- **Dependencies**: Change 2.2 (PerformanceChart update)
- **Testing approach**: Verify heading appears inside chart, not duplicated above

##### Change 2.2: Add benchmark label to PerformanceChart component
- **File**: `front-end/src/components/research/PerformanceChart.tsx:37-49`
- **Description**: Add "Benchmark 01 — SWE Bench" label at the top of the chart component, before the existing "SWE Bench" label
- **Current code**:
```tsx
<section className="rounded-3xl border border-slate-200 bg-slate-50/60 p-8 space-y-8">
  <div className="space-y-3">
    <p className="text-[11px] font-medium uppercase tracking-[0.4em] text-slate-400">SWE Bench</p>
    ...
  </div>
```
- **Proposed change**: Add a new label above "SWE Bench" with "Benchmark 01 — SWE Bench" text, styled similarly to other benchmark labels
- **Dependencies**: None
- **Testing approach**: Visual verification that label appears correctly inside chart

##### Change 2.3: Remove duplicate headings from Research.tsx for Benchmark 02
- **File**: `front-end/src/pages/Research.tsx:103-118`
- **Description**: Remove the duplicate "Benchmark 02 — Cost Surface" label and heading that appears above CostComparisonChart
- **Current code**:
```tsx
<section className="space-y-5">
  <p className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400">
    Benchmark 02 — Cost Surface
  </p>
  <h2 className="text-3xl font-semibold">Frontier performance at a fraction of the spend</h2>
  <p className="text-lg text-slate-700 leading-relaxed">
    We are obsessive about accessibility...
  </p>
  <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
    <CostComparisonChart />
  </div>
  ...
</section>
```
- **Proposed change**: Remove the `<p>` label and `<h2>` heading, keep only the description paragraph and chart wrapper. Update CostComparisonChart to include "Benchmark 02 — Cost Surface" label inside.
- **Dependencies**: Change 2.4 (CostComparisonChart update)
- **Testing approach**: Verify heading appears inside chart, not duplicated above

##### Change 2.4: Add benchmark label to CostComparisonChart component
- **File**: `front-end/src/components/research/CostComparisonChart.tsx:22-28`
- **Description**: Add "Benchmark 02 — Cost Surface" label at the top of the chart component, before the existing heading
- **Current code**:
```tsx
<div className="w-full max-w-4xl mx-auto py-16">
  <h2 className="text-3xl font-semibold text-center mb-12 text-gray-900">
    Rose-1 delivers frontier performance
    ...
  </h2>
```
- **Proposed change**: Add a new label above the h2 with "Benchmark 02 — Cost Surface" text, styled similarly to other benchmark labels
- **Dependencies**: None
- **Testing approach**: Visual verification that label appears correctly inside chart

##### Change 2.5: Remove duplicate headings from Research.tsx for Benchmark 03
- **File**: `front-end/src/pages/Research.tsx:120-135`
- **Description**: Remove the duplicate "Benchmark 03 — Accuracy over time" label and heading that appears above AccuracyOverTimeChart
- **Current code**:
```tsx
<section className="space-y-5">
  <p className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400">
    Benchmark 03 — Accuracy over time
  </p>
  <h2 className="text-3xl font-semibold">Agentic training yields compounding accuracy</h2>
  <p className="text-lg text-slate-700 leading-relaxed">
    Screenshot 2 from the Cursor research note...
  </p>
  <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
    <AccuracyOverTimeChart />
  </div>
  ...
</section>
```
- **Proposed change**: Remove the `<p>` label and `<h2>` heading, keep only the description paragraph and chart wrapper. Update AccuracyOverTimeChart to include "Benchmark 03 — Accuracy over time" label and heading inside.
- **Dependencies**: Change 2.6 (AccuracyOverTimeChart update)
- **Testing approach**: Verify heading appears inside chart, not duplicated above

##### Change 2.6: Add benchmark label and heading to AccuracyOverTimeChart component
- **File**: `front-end/src/components/research/AccuracyOverTimeChart.tsx:39-41`
- **Description**: Add "Benchmark 03 — Accuracy over time" label and "Agentic training yields compounding accuracy" heading at the top of the chart component
- **Current code**:
```tsx
return (
  <div className="w-full max-w-6xl mx-auto py-8">
    <div className="relative w-full h-96 bg-gradient-to-br from-gray-50 to-white rounded-2xl p-12 border border-gray-200">
```
- **Proposed change**: Add a header section above the chart div with the benchmark label and heading, styled consistently with other charts
- **Dependencies**: None
- **Testing approach**: Visual verification that label and heading appear correctly inside chart

#### Phase 3: Update Fonts to Inter

##### Change 3.1: Update font-family for research page to use Inter
- **File**: `front-end/src/pages/Research.tsx:8`
- **Description**: Add font-family class to main element to use Inter font instead of default Geist
- **Current code**:
```tsx
<main className="min-h-screen bg-white text-slate-900">
```
- **Proposed change**: Add `font-['Inter']` class or create a CSS class that applies Inter font to the research page
- **Dependencies**: None
- **Testing approach**: Visual verification that Inter font is applied (check browser dev tools)

##### Change 3.2: Add CSS class for Inter font family (optional, if needed)
- **File**: `front-end/src/index.css`
- **Description**: If Tailwind doesn't support Inter directly, add a custom CSS class for Inter font family
- **Current code**: Font-family is set globally in body/header rules
- **Proposed change**: Add a `.font-inter` utility class or update the research page to use Inter via inline style or CSS module
- **Dependencies**: None
- **Testing approach**: Verify Inter font loads and displays correctly

### Testing Plan

#### Unit Tests
- No unit tests needed (visual/styling changes only)

#### Integration Tests
- No integration tests needed (visual/styling changes only)

#### Manual Verification
- [ ] Navigate to `/research` page
- [ ] Verify "Research Report – July 2025" displays correctly (no extra spacing from p tag)
- [ ] Verify "By Andy Prevalsky · July 2025" displays correctly (no extra spacing from p tag)
- [ ] Verify "Mission" label displays correctly
- [ ] Verify "Benchmark 01 — SWE Bench" appears inside PerformanceChart, not above it
- [ ] Verify "Benchmark 02 — Cost Surface" appears inside CostComparisonChart, not above it
- [ ] Verify "Benchmark 03 — Accuracy over time" appears inside AccuracyOverTimeChart, not above it
- [ ] Verify Inter font is applied to the research page (check computed styles in browser dev tools)
- [ ] Verify no duplicate headings appear
- [ ] Verify all text formatting matches Cursor's research report aesthetic

### Dependencies & Order
1. Phase 1 (fix p tags) can be done independently
2. Phase 2 (move headings) must be done in order:
   - Change 2.1 depends on Change 2.2 (remove from parent after adding to chart)
   - Change 2.3 depends on Change 2.4 (remove from parent after adding to chart)
   - Change 2.5 depends on Change 2.6 (remove from parent after adding to chart)
3. Phase 3 (fonts) can be done independently or alongside other changes

### Risks & Mitigations
- **Risk**: Removing headings from parent might break layout spacing
  - **Mitigation**: Keep the section wrapper and description paragraphs, only remove the label and heading elements
- **Risk**: Font change might not apply if Tailwind doesn't recognize Inter
  - **Mitigation**: Use inline style or CSS class to explicitly set font-family to 'Inter'
- **Risk**: Chart components might look cramped with headings inside
  - **Mitigation**: Adjust padding/spacing in chart components to accommodate headings

### Open Questions
- [ ] Should we keep the description paragraphs above charts, or move those inside too?
- [ ] Should all charts follow the exact same heading pattern, or can they vary slightly?

### Estimated Scope
- Lines of code: ~50-70 lines modified
- Files modified: 5 files
- Time estimate: 30-45 minutes









