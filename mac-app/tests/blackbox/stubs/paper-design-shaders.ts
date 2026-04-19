// Test-time stub for `@paper-design/shaders`.
//
// The real package ships WebGL-driven shader components that cannot run in
// jsdom (no WebGL context, no browser compositor). It's declared as a
// dependency of `front-end/` — not `mac-app/` — so importing it from
// `mac-app/ui/launcher/main.tsx` or `mac-app/ui/onboarding/Onboarding*.tsx`
// under vitest fails resolution.
//
// vitest.config.ts aliases the bare specifier to this file so entry-level
// blackbox tests (which import the whole module graph) can mount without
// touching GPU APIs. Tests assert on DOM/IPC contract only — never on shader
// output — so a no-op stub is fully sufficient.
export const liquidMetalFragmentShader = 'void main(){}';

export class ShaderMount {
  constructor() {}
  dispose(): void {}
}
