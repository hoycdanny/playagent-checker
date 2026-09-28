# Research: VLM coordinate accuracy on game screens

## Question

Can a general-purpose vision model (Claude, Qwen3-VL) locate tap targets accurately enough on art-heavy game screens, or do we need a GUI-specialized grounding model?

## Method

On a real slot-game login screen (device 1080×2404, smart-resized to 952×2156), we asked each model for the pixel coordinate of a specific small icon (the Google sign-in button on the bottom row). We compared the returned coordinate against the icon's true center, both on a clean screenshot and on a screenshot with a pixel-coordinate grid overlaid.

## Findings

| Model | Input | Error vs true center |
| --- | --- | --- |
| Claude Sonnet 4.5 | clean | ~292 px |
| Claude Sonnet 4.5 | + pixel grid | ~292 px (no improvement) |
| Qwen3-VL 235B | clean | ~735 px |
| Qwen3-VL 235B | + pixel grid | ~738 px (no improvement) |

- General VLMs missed by hundreds of pixels — enough to tap empty space or the wrong element.
- A coordinate-grid overlay did **not** help; the models did not read the ticks to correct themselves.
- The coordinate *pipeline* (smart-resize, mapping back to device pixels) was verified correct — the error was in the model's visual grounding, not the math.

## Consequence

Adopt **UI-TARS-1.5-7B** (fine-tuned for GUI grounding) for the VLM seat, deployed on SageMaker. In an end-to-end run on the same screen, UI-TARS placed the tap marker precisely on its intended target, versus the ~292 px miss from Claude. See [../design/uitars-sagemaker-grounding.md](../design/uitars-sagemaker-grounding.md).

## Key detail: max-pixels cap

UI-TARS-1.5-7B grounding degrades on large images. Capping smart-resize at **2,116,800** pixels (the OSWorld cap) rather than the Hugging Face default (~12.8M) is essential: measured ~40 px error at 2.1M vs ~200 px at 12.8M on a 2340×1080 frame.
