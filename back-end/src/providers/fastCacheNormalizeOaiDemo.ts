/**
 * OAi demo (test-mass-agent-run-0) goalHash canonicalization.
 *
 * Split from fastCacheNormalizeCore so the core module stays under max-lines.
 * Keep the July execute_loop aliases in sync with
 * agents/domains/spawn_agent/oai_demo_july.py JULY_GP_GOAL_HASHES.
 */

export const OAI_DEMO_ROOT_GOAL_PREFIX =
  "I'm building a [REDACTED] brand for health, longevity, technology, founder journey"; // pragma: allowlist secret
export const OAI_DEMO_CHILD_WINDOW = '2026-04-04 through 2026-07-03'; // pragma: allowlist secret
const OAI_DEMO_CACHE_SOURCE_NAME = 'Aman Gottumukkala';
const OAI_DEMO_CACHE_DISPLAY_NAME = 'Andy Prevalsky';

export function canonicalizeOaiDemoGoalForHash(goal: string): string {
  if (!goal.includes(OAI_DEMO_ROOT_GOAL_PREFIX) && !goal.includes(OAI_DEMO_CHILD_WINDOW)) {
    return goal;
  }
  return goal
    .split(OAI_DEMO_CACHE_DISPLAY_NAME)
    .join(OAI_DEMO_CACHE_SOURCE_NAME)
    .split("Andy's")
    .join("Aman's");
}

const OAI_DEMO_JULY_GP_GOAL_HASHES: Record<string, string> = {
  'andrew huberman': '5e1731f836723fb1',
  'bryan johnson': 'd5ca1a36cddc02e8',
  'peter attia': '65d4e0248f84bef8',
  'rhonda patrick': '2f47e3eca2f296ff',
  'tim ferriss': 'a40f6dd9ace06b6c',
  'dave asprey': '115e7be730aed584',
  'gary brecka': '1f60137116da569c',
  'siim land': '0bbe6c23b5474687',
  'ben greenfield': '90b0a43f90f89a32',
  'nick norwitz': 'd04510d762923977',
  'lex fridman': '76cb88bce8d5601e',
  'ali abdaal': '5872737e678bfc65',
  'chris williamson': '7499abccb0ac6254',
  'steven bartlett': 'd1468d3a9902a441',
  'mark hyman': 'c03723fa4f8d0a16',
  'david sinclair': 'fc5ce39ab0a4a623',
  'casey means': '7248e1394c92f55a',
  'gabrielle lyon': '3810fb0b74874b94',
  'molly maloof': '7eb95b8370d708bf',
  'max lugavere': 'a0b13ab93bd09046',
  'thomas delauer': '7a3c645db605a7ef',
  'michael lustgarten': '764c4fee3d3cf4a3',
  'matt kaeberlein': 'cd80f8c386e7d757',
  'eric topol': 'a33288f6c3a3e484',
  'sahil bloom': '5b7a30a3a6457ba2',
  'dan koe': 'b5db973bb7c104af',
  'justin welsh': 'ebdf32d4d67cb7b8',
  'greg isenberg': 'dd1a526203fdf1fe',
  'lenny rachitsky': 'b5d6d367be511c8d',
  'gergely orosz': '4f1e222cdd445fa8',
  'ethan mollick': '92db2b751402e7f7',
  'allie k. miller': '122bf1458146116c',
  'rowan cheung': 'c859f0437a780aa9',
  'matt wolfe': '9bd2ac19e313b421',
  'roberto nickson': '5c1c1e4873818cfd',
  'tina huang': 'c97f6411e974f999',
  'pieter levels': '2a5047c41ade580c',
  'brett adcock': 'cd0f862fb5fc3094',
  'andrew wilkinson': '8cac2a39243299c3',
  'naval ravikant': '9ddf1e01d959def4',
  'sam parr': '2be5e2ad477bd394',
  'codie sanchez': '07bda83296ad43be',
  'marques brownlee': 'ceefe41146c9aefc',
  'khe hy': '754e78c9cadc9979',
  'thomas frank': 'df7ecb881efd0d2d',
  "matt d'avella": '0bbf025f0cced030',
  'joey schweitzer': 'ed289c2a0fcc45e6',
  'nathaniel drew': '74732a761f790f81',
  'wes roth': '934c2b9720294e60',
  'ranveer allahbadia': '8490ce582e612e06',
};

function normalizeOaiDemoCreatorKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s+/, '')
    .split(' / ')[0]
    .trim()
    .replace(/\s+/g, ' ');
}

export function julyGpGoalHashForGoal(goal: string): string | undefined {
  const match =
    goal.match(/"creator_name"\s*:\s*"([^"]+)"/) ||
    goal.match(/"name"\s*:\s*"([^"]+)"/) ||
    goal.match(/Creator:\s*([^\n]+)/);
  const name = match?.[1]?.trim().replace(/\.+$/, '').trim();
  if (!name) return undefined;
  return OAI_DEMO_JULY_GP_GOAL_HASHES[normalizeOaiDemoCreatorKey(name)];
}
