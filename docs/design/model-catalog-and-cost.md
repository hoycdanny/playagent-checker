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
- Region prefix (`us.`) is applied per provider automatically.
- **UI-TARS** appears as `uitars`: vlm-only, `pixel` coordinates, `sagemaker` channel.

The `/models?seat=vlm` API drives the frontend dropdown, so it never goes stale.

## Pricing & fail-closed

`pricing.ts` maps each catalog modelId to a per-million-token price (Anthropic list prices are authoritative; others are AWS Pricing API estimates marked "estimated"). A startup invariant asserts every catalog entry is priceable.

Before a run, the engine locks a price snapshot for each active seat. **Fail-closed:** if a price is unknown, the run is refused before any spend. During the run, execution halts once accumulated spend reaches the task budget. Reports show actual spend and token usage.

UI-TARS is priced at 0/token because its cost is the SageMaker endpoint's GPU-hour billing, tracked separately from token accounting.
