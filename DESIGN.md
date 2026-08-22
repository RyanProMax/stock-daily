# Stock Daily visual system

Stock Daily is an editorial market brief. Its interface should prioritize rapid reading, evidence, and clear market direction over dashboard decoration.

## Core palette

- **Brand — deep green `#123B34`:** the primary theme color. Use it for navigation state, structural section bars, and major editorial anchors.
- **Paper `#F5F0E6` / surface `#FBF8F1`:** the reading canvas and content surfaces.
- **Market up / favorable — coral `#C85A43`:** follows the Chinese market convention for gains and favorable impact.
- **Market down / adverse — green `#16785F`:** follows the Chinese market convention for declines and adverse impact.
- **Ink `#132621`:** primary reading text.

The semantic tokens in `src/styles.css` are the implementation authority. Do not introduce another primary brand color or reverse the market-direction convention inside an individual component.

## Interface principles

- Lead with one market conclusion; supporting facts and detailed transmission remain progressively disclosed.
- Market direction must be recognizable from the whole data cell, not only from a small badge.
- Use deep green as structure, not as a generic positive-state color.
- Avoid reader-facing generation, provider, scoring, or pipeline terminology.
- Historical navigation stays visually subordinate to the current report.
