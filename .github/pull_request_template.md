name: Pull request

## What and why

<!-- What changed, and what problem it solves. If this fixes an issue, link it. -->

## Invariants

Tick the ones your change touches, and expect discussion on any of them:

- [ ] Advisory only — no `APPROVE`, no `REQUEST_CHANGES`, no merge gating, no
      failure caused by a finding
- [ ] No PR-controlled code execution — no `child_process`, `eval`, `Function`,
      git, or package-manager invocation
- [ ] No paid routing — all three guards intact (config-time `:free` regex,
      per-request assertion, `provider.max_price` zero)
- [ ] Anchors resolved locally, never taken from model output
- [ ] Run status does not overclaim — `no_findings` only when a review actually ran
- [ ] Bumped `PROMPT_VERSION` — required for any change to the prompt, finding
      schema, or severity definitions

## Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm test` all pass
- [ ] `npm run build` run and `dist/` committed — CI fails without this
- [ ] `npm run check:dist` passes
- [ ] Added or updated tests; property tests added if you touched anchoring or dedupe
- [ ] Did **not** read the `held-out` golden dataset while tuning a prompt
- [ ] CHANGELOG handled by conventional commit, not manual edit

## Notes for reviewers

<!-- Anything non-obvious: a tradeoff you made, an invariant you suspect is at risk, a number you measured. -->

If this adds a model, state its verified provider data-retention posture and the
date you verified it. That cannot be checked at runtime.
