#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { clipExploreEvidence } from '../../domains/agents/exploreEvidenceService';

// Same source/header + four long lifestyle paragraphs as the timed-out Denver fetch.
const fetchedGuide = [
  'Source: https://bungalow.com/articles/best-neighborhoods-in-denver-co',
  'Title: The 11 Best Neighborhoods to Live in Denver',
  'Date: Jun 13th, 2023',
  '',
  `The article ranks neighborhoods by atmosphere, amenities, and experience. ${'Citywide scoring context. '.repeat(28)}`,
  '',
  'Best fits by requested lifestyle:',
  '',
  `- Urban/nightlife: Capitol Hill, Golden Triangle, Five Points, Baker, Highlands, University, and Lincoln Park. ${'Bars, restaurants, arts, and transit. '.repeat(25)} Tradeoffs: higher rent and limited space.`,
  '',
  `- Walkable/culture: Golden Triangle, Five Points, Baker, Highlands, and Capitol Hill. ${'Museums, galleries, and jazz history. '.repeat(17)} Tradeoff: some areas are noisy at night.`,
  '',
  `- Families/parks: South Park Hill, Cherry Creek, Washington Park, and Sloans Lake. ${'Schools, trails, and green space. '.repeat(19)} Tradeoffs: higher home prices and quieter nightlife.`,
  '',
  `- Value/affordable: University and Lincoln Park. ${'Below-average rent and student options. '.repeat(19)} Tradeoff: smaller homes and less parking.`,
  '',
  `Ranking and editorial details. ${'Further source notes. '.repeat(30)}`,
].join('\n');

const excerpt = clipExploreEvidence(fetchedGuide);
assert(excerpt.length <= 1200, `excerpt exceeded existing per-result cap: ${excerpt.length}`);
for (const fact of [
  'https://bungalow.com/articles/best-neighborhoods-in-denver-co',
  'Capitol Hill',
  'Golden Triangle',
  'South Park Hill',
  'Washington Park',
  'University',
  'Tradeoff',
]) {
  assert(excerpt.includes(fact), `recovered excerpt lost ${fact}`);
}
for (const sectionCount of [2, 3, 4, 5, 6]) {
  const sections = Array.from(
    { length: sectionCount },
    (_, index) =>
      `- Section ${index + 1}: Neighborhood ${index + 1}. ${'Detailed source findings. '.repeat(100)} Tradeoff: noise.`
  );
  const sampled = clipExploreEvidence(
    ['Source: https://example.com/very-long-source', 'Title: Neighborhoods', '', ...sections].join(
      '\n\n'
    )
  );
  assert(sampled.length <= 1200, `${sectionCount} sections exceeded the existing cap`);
  assert(sampled.includes('https://example.com/very-long-source'));
  for (let index = 1; index <= sectionCount; index += 1) {
    assert(sampled.includes(`Neighborhood ${index}`), `lost section ${index} of ${sectionCount}`);
  }
}
