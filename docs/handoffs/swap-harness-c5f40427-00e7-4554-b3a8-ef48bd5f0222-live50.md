# Benchmark Infra original LIVE50 source and helpers

Old box `c5f40427-00e7-4554-b3a8-ef48bd5f0222`; original main Claude session `17b2573b-417f-49ba-bf6d-0f84dbb474f8`.
Current source before this checkpoint: `6e0b6e481f7099a149196de9b3368afccfce5474`.
The two existing trial source marker commits are retained in ancestry. The modified descend_steps ledger is preserved unchanged. Selected original ignored experiment, deployment and review helper files are explicitly included at their original paths below. These scripts retain the old runtime identity for evidence and must not be launched on a new box without fresh setup.

See PR1478's canonical handoff `docs/handoffs/swap-harness-c5f40427-00e7-4554-b3a8-ef48bd5f0222.md` for goals, remaining work and resources. Trial 1 and trial 2 did not qualify; 0/5 remains accepted. Trial 2's summary records 48 passed jobs and 2 failed jobs, but that status alone proves neither LIVE provider qualification nor complete native release.

Normal hooks were retained. No migration-time execution tests were run: this checkpoint records the original in-progress work without changing its implementation. Full task gates and exact-owner reconciliation remain pending. Preserve Freedom and protected instructions; no merge/deploy is authorized by migration itself.

## Exact original ignored source files

These copies are not in the current tree; they remain at their original paths in commit `ff1940fe9` (`git show ff1940fe9:<path>`).

```json
[
  {
    "path": ".context/daily-live50/agg-monitor.py",
    "sha256": "d8edaf524e2674f4253c80c4f5f6635b35d870d5500058b538326c9c663ef28d",
    "bytes": 1844
  },
  {
    "path": ".context/daily-live50/launch.sh",
    "sha256": "4e34795b4d0e60c216a97f27a2e974166c5d40a8373b7414b53eda30f821cb3b",
    "bytes": 1528
  },
  {
    "path": ".context/daily-live50/poll-campaign.py",
    "sha256": "482a4bd765302952e7e7282c5889a2d08ea05e3b4486d17c14629b70da69a1b1",
    "bytes": 1164
  },
  {
    "path": ".context/daily-live50/prepare.sh",
    "sha256": "2c22921d89e814e936a2ff700b7100fab1d8a52b32b477fc1380c16b848cbba1",
    "bytes": 2137
  },
  {
    "path": ".context/daily-live50/status-report.py",
    "sha256": "2dfcb9e55cc81d5e44cdbb8955957bbf0987a5c04d64046ee2660b5ac10e359f",
    "bytes": 3475
  },
  {
    "path": ".context/deploy-delegation/prompt-donor-snapshot.md",
    "sha256": "2e46e6aa908884eb22c842bc1096b73768e40de73842a780b5e3a4add63cea81",
    "bytes": 4698
  },
  {
    "path": ".context/g3/agents.sh",
    "sha256": "fddf58414f7d8a38bceb8650eecb184925e022f6db0bf8eba5165d132337d6bd",
    "bytes": 195
  },
  {
    "path": ".context/g3/backend.sh",
    "sha256": "6c72a52dc43f64539d1c3003ac212e7312755629558cfb378c74dc439b667b74",
    "bytes": 245
  },
  {
    "path": ".context/g3/frontend.sh",
    "sha256": "187ffbdf14ef55360d53ab07b6ffae1c9a7992b7f1102067db962e62769dc19c",
    "bytes": 179
  },
  {
    "path": ".context/g3/poll.sh",
    "sha256": "e5b3bdb3a31f0c0ec54589e63f873c5b97db3b95f63f47bd608da6b19997a4d2",
    "bytes": 830
  },
  {
    "path": ".context/g3/static.sh",
    "sha256": "1854d0d011ab8861144c08ecb200ec75d047e14d0c3f65fb1072e494cdfd2c08",
    "bytes": 991
  },
  {
    "path": ".context/g3/step4cb.sh",
    "sha256": "b6b8f7536497958f695a082859920e82ef41289a3e2e6c0270c991b60a7f15d5",
    "bytes": 5284
  },
  {
    "path": ".context/g4/cr-4243800445.md",
    "sha256": "82a9539b329ad10de02d84d601ceb290e2bf9b1f42bfa3c4b74b54081001242f",
    "bytes": 4791
  },
  {
    "path": ".context/g4/cr-4243800448.md",
    "sha256": "95d41c5dacab4146a2b8a1df4e59f2126129272a7e57bfa0c3ee0393fc02bfc5",
    "bytes": 2950
  },
  {
    "path": ".context/g4/cr-4243800451.md",
    "sha256": "f9a569eeb10cfbda8bed425e8f5f8aa653f5603963e65ac5db39c604085da922",
    "bytes": 4143
  },
  {
    "path": ".context/g4/cr-4243800456.md",
    "sha256": "df6cf30af5ae3e9627b50609175b1503dfdceda88d13073453b785ce5dcdda95",
    "bytes": 3393
  },
  {
    "path": ".context/g4/cr-4243800459.md",
    "sha256": "7d58a06376c47d81f47b8d6e0a20cd49f652a48134d97eb0930507d935bb8ca7",
    "bytes": 4659
  },
  {
    "path": ".context/g4/e2b.sh",
    "sha256": "292e7479f0741f7d47e362117dd1829fb9bb357c14135989651d47352323f32f",
    "bytes": 802
  },
  {
    "path": ".context/g4/fallback-c2.ts",
    "sha256": "12bf7c7dcc062ae27367d4b23c51796c1684252f5277341fa745207cd511691e",
    "bytes": 21
  },
  {
    "path": ".context/g4/fallback-wait.sh",
    "sha256": "66025640e6c213dca37d6a2dc7a4c8cc286398f5e69e56a816a78cbbbd034819",
    "bytes": 1008
  },
  {
    "path": ".context/g4/pooler-watch.sh",
    "sha256": "ca38950b69579faf45e2a8841bc061d9d0d529107720ed558f54ca4ee9ab2aea",
    "bytes": 330
  },
  {
    "path": ".context/g4/retry-lane.sh",
    "sha256": "5f06ec123e7c554c04c175ca2b70bb073ad12b62ef3ad2024faeae0a22a8d754",
    "bytes": 800
  },
  {
    "path": ".context/g4/review-5436.ts",
    "sha256": "d4bec7781bc2b4978452520c2005f0e16c5e47a005fdd8a3d96f385e3c3c8f53",
    "bytes": 21
  },
  {
    "path": ".context/g4/review-76d0.ts",
    "sha256": "8f23d6c567ed3e1b73feb60e3013f190d35ae17af7834fa0da72bcebb7fc7974",
    "bytes": 21
  },
  {
    "path": ".context/g4/review-ba6e-full.ts",
    "sha256": "953e1f55d537d0d89e8440f293e8bc0b599de306659dfd40f88e16ac1dfcc289",
    "bytes": 21
  },
  {
    "path": ".context/g4/review-ba6e.ts",
    "sha256": "8f4d5b569cb372b239f15da584d5d6e729afb9a7d0cdc072e53d817d3ee0edbd",
    "bytes": 21
  },
  {
    "path": ".context/g4/review-final.ts",
    "sha256": "cb75b020a5adb8c4daf34b83e2332dbfe6ada7841f1b4abd5f0e45b0342a2cbe",
    "bytes": 21
  },
  {
    "path": ".context/g4/review-final2.ts",
    "sha256": "35755dec893ab300cc0c2c6c3927897ee59d0d8d1a47ff8f9a86482e5147dd45",
    "bytes": 21
  },
  {
    "path": ".context/g4/semantic.sh",
    "sha256": "0b6bb0b84fe25700707cb4210086376265c35558136a050474d62609ce8a3cfc",
    "bytes": 707
  },
  {
    "path": ".context/g4/stack.sh",
    "sha256": "1fb37d1bd8985549f007870a4bd1dd55f4fa0dcb6ca118ae1d11aa2b90aac892",
    "bytes": 526
  },
  {
    "path": ".context/g5/agentcard.sh",
    "sha256": "4c29d686983e53fe01225b0bdd201cc175e8df92089ac6e9fff656c697331c10",
    "bytes": 365
  },
  {
    "path": ".context/g5/common.sh",
    "sha256": "cd7b4a5e875927cd2cc1a85998f1ec8341b7a27710c7d26b1a645ad4e2c90318",
    "bytes": 86
  },
  {
    "path": ".context/g5/fly.sh",
    "sha256": "77446c2679af4e48bc94b450400c4696913e2947734dac844b1d7f3f66d278e0",
    "bytes": 2443
  },
  {
    "path": ".context/g5/mac.sh",
    "sha256": "761d210fb5ca1ae1f0b376aa17db18c6cfae5c41968f8f3ca63bfd1effeeaa66",
    "bytes": 1014
  },
  {
    "path": ".context/g5/render.sh",
    "sha256": "3a4f31f032217eb4fbed9a35de98771af979d71563daf32c3064262e6f6af369",
    "bytes": 2502
  },
  {
    "path": ".context/g5/semantic.sh",
    "sha256": "e6473cf7d76576e420ec5f5b7d5240425d5a2aff09d5fe369728a288ab210fae",
    "bytes": 1220
  },
  {
    "path": ".context/g5/vercel.sh",
    "sha256": "5f0ec4334bb6a20e66fb8124f37b40dc0a2586871840137dd6c3daa7e34ce306",
    "bytes": 1092
  },
  {
    "path": ".context/g6/review-c2.ts",
    "sha256": "52da76f3718afb7e1ef7d6e9d44cc9a3e9d194df9c562f292fa0fbe7d25a962d",
    "bytes": 21
  },
  {
    "path": ".context/g6/review-c2b.ts",
    "sha256": "a209b7d9cbb3b746488994f06df57c655ace2338be4d49d70070e5b3f0f2ba1a",
    "bytes": 21
  },
  {
    "path": ".context/hub-stall/hub-index-repair.ts",
    "sha256": "23f23321bca08d990ec86b8e1dabf6b846e8f41768fb0ef5ffe86d75febeb2ab",
    "bytes": 3455
  },
  {
    "path": ".context/recipe_fingerprint.py",
    "sha256": "74f17a9303d284e9b63d5ec2de590e68cf913657266429255698f5fd319d7adc",
    "bytes": 1648
  },
  {
    "path": ".context/implicit_timeouts.py",
    "sha256": "301950ba4e6d6a4cb85fa7fa889c027d00aa2268670ce2d631f88224b21a9c50",
    "bytes": 1279
  },
  {
    "path": ".context/daily_timeouts.py",
    "sha256": "dc6ae5d86f349d36ea1bf1e1a69e71a881a2e23dbd6e65f9d463a9c6eb660421",
    "bytes": 1714
  }
]
```
