/**
 * OAi demo (test-mass-agent-run-0) goalHash canonicalization.
 *
 * Split from demoCacheNormalizeCore so the core module stays under max-lines.
 * Keep the July execute_loop aliases in sync with
 * agents/domains/spawn_agent/oai_demo_july.py JULY_GP_GOAL_HASHES.
 */

export const OAI_DEMO_ROOT_GOAL_PREFIX =
  "I'm building a personal brand for health, longevity, technology, founder journey"; // pragma: allowlist secret
export const OAI_DEMO_CHILD_WINDOW = '2026-04-04 through 2026-07-03'; // pragma: allowlist secret
export const OAI_DEMO_CHILD_GOAL_PREFIX = 'You are analyzing ONE creator';
export const OAI_DEMO_CACHE_SOURCE_NAME = 'Aman Gottumukkala';
export const OAI_DEMO_CACHE_DISPLAY_NAME = 'Andy Prevalsky';

function isOaiDemoBoundChildGoal(text: string): boolean {
  // Child prefix alone is not enough — require a DEMO identity binding so
  // unrelated goals containing the prefix cannot enter cache replay.
  if (!text.includes(OAI_DEMO_CHILD_GOAL_PREFIX)) return false;
  return (
    text.includes(OAI_DEMO_CACHE_DISPLAY_NAME) ||
    text.includes(OAI_DEMO_CACHE_SOURCE_NAME) ||
    text.includes(OAI_DEMO_CHILD_WINDOW) ||
    text.includes(OAI_DEMO_ROOT_GOAL_PREFIX)
  );
}

export function isOaiDemoGoal(goal: string | null | undefined): boolean {
  const text = goal ?? '';
  return (
    text.includes(OAI_DEMO_ROOT_GOAL_PREFIX) ||
    text.includes(OAI_DEMO_CHILD_WINDOW) ||
    isOaiDemoBoundChildGoal(text)
  );
}

export function canonicalizeOaiDemoGoalForHash(goal: string): string {
  if (!isOaiDemoGoal(goal)) {
    return goal;
  }
  return goal
    .split(OAI_DEMO_CACHE_DISPLAY_NAME)
    .join(OAI_DEMO_CACHE_SOURCE_NAME)
    .split("Andy's")
    .join("Aman's");
}

export const OAI_DEMO_JULY_GP_GOAL_HASHES: Record<string, string> = {
  'andrew huberman': '5e1731f836723fb1',
  'bryan johnson': '2ffa1fbe4843a00f',
  'peter attia': '65d4e0248f84bef8',
  'rhonda patrick': '2f47e3eca2f296ff',
  'tim ferriss': '308533b0687c42f1',
  'dave asprey': '705d208b550fabf9',
  'gary brecka': '822459b31c94bebd',
  'siim land': '5b50a433ea00553e',
  'ben greenfield': '90b0a43f90f89a32',
  'nick norwitz': '822212860717c80f',
  'lex fridman': 'd587ab24de079872',
  'ali abdaal': '5872737e678bfc65',
  'chris williamson': '7499abccb0ac6254',
  'steven bartlett': '3389a431c3c428c2',
  'mark hyman': 'cf733069e1f8e594',
  'david sinclair': '1eb48490335b5913',
  'casey means': '918974d8c4516a50',
  'gabrielle lyon': 'bfd8e1b50f417841',
  'molly maloof': 'a9edd0c280965a52',
  'max lugavere': '870aa798f805d115',
  'thomas delauer': 'da9ab880f5cf47b0',
  'michael lustgarten': '764c4fee3d3cf4a3',
  'matt kaeberlein': 'e77071601a788aad',
  'eric topol': 'a33288f6c3a3e484',
  'sahil bloom': '3fd2fec61970ac83',
  'dan koe': 'b5db973bb7c104af',
  'justin welsh': 'ebdf32d4d67cb7b8',
  'greg isenberg': 'b47929301a17dd66',
  'lenny rachitsky': '185ab81fcd1829e7',
  'gergely orosz': '4f1e222cdd445fa8',
  'ethan mollick': '92db2b751402e7f7',
  'allie k. miller': '122bf1458146116c',
  'rowan cheung': 'c1a89807a217bd39',
  'matt wolfe': '9bd2ac19e313b421',
  'roberto nickson': '5c1c1e4873818cfd',
  'tina huang': 'c97f6411e974f999',
  'pieter levels': '2a5047c41ade580c',
  'brett adcock': 'cd0f862fb5fc3094',
  'andrew wilkinson': '3abe247e3d0191bf',
  'naval ravikant': '4685e8b287fb3986',
  'sam parr': 'de9db95dc0ccc267',
  'codie sanchez': '07bda83296ad43be',
  'marques brownlee': 'ceefe41146c9aefc',
  'khe hy': '754e78c9cadc9979',
  'thomas frank': 'df7ecb881efd0d2d',
  "matt d'avella": '83865d527880b2b7',
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
