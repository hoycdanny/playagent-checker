# Design: Model catalog, seats, and cost guardrails

## Seats, not vendors

Every model is chosen for a **role (seat)**:

- **Agent** — decision-making.
- **VLM** — coordinate grounding (needs vision).
- **SubAgent** — light sub-tasks (cheap model).

Each seat is selected independently per task. Only vision-capable catalog entries may take the VLM seat; text-only entries take Agent/SubAgent.

## Catalog

`infra/lambda/api/modelCatalog.ts` is the single authority for selectable models. Each entry carries: `modelId`, `displayName`, `regions`, `coordSystem` (`pixel` | `norm1000`), `seats`, and a derived `channel`.

- `channel` (bedrock / bedrock-converse / openai / **sagemaker**) is derived from the modelId — users never pick it.
- Region prefix (`us.`) is applied **per model, not per provider**: a model sold as `ON_DEMAND` must be
  called with the plain foundation-model id, while an `INFERENCE_PROFILE`-only model must be called as
  `us.<id>`. Guessing wrong gives the same message for both mistakes —
  `ValidationException: The provided model identifier is invalid.` — and it only surfaces on the first
  model call, i.e. after the device has booted and the app is installed.
  One provider can contain both kinds (`mistral.pixtral-large` needs the profile, `mistral.mistral-large-3`
  must not have it), so provider-wide rules break as soon as AWS adds on-demand models to a provider
  that previously had none. Run `node infra/scripts/check-model-ids.mjs [--invoke]` after editing the
  catalog; it compares every entry against ListFoundationModels + ListInferenceProfiles (and optionally
  really calls each id) and fails with a non-zero exit code.
- `unavailable` marks an entry that is listed but currently **cannot be called** (retired model, legacy
  model whose access was revoked, or one that needs account settings we do not have). Those options are
  greyed out in the pickers, rejected by `POST /tasks` with 400, and refused by the engine's config
  snapshot — so they can never burn device time before failing.
- **UI-TARS** appears as `uitars`: vlm-only, `pixel` coordinates, `sagemaker` channel.

The `/models?seat=vlm` API drives the frontend dropdown, so it never goes stale.

## Pricing & fail-closed

`pricing.ts` maps each catalog modelId to a per-million-token price (Anthropic list prices are authoritative; others are AWS Pricing API estimates marked "estimated"). A startup invariant asserts every catalog entry is priceable.

Before a run, the engine locks a price snapshot for each active seat. **Fail-closed:** if a price is unknown, the run is refused before any spend. During the run, execution halts once accumulated spend reaches the task budget. Reports show actual spend and token usage.

UI-TARS is priced at 0/token because its cost is the SageMaker endpoint's GPU-hour billing, tracked separately from token accounting.
