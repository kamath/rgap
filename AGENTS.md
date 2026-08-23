# Repository Instructions

## README-first workflow

Before making any coding edit, update `README.md` first to describe the proposed behavior, design, or interface.

After updating `README.md`, stop and obtain the user's explicit approval of that README change. Do not create, modify, or delete code, tests, schemas, migrations, configuration, or other implementation files until approval is received.

Once the README change is approved, implement exactly the approved design. If implementation requires a material design change, update the README and obtain approval again before continuing.

## README style

- Write `README.md` in the present tense.
- Describe the system as it exists under the current design.
- Do not discuss legacy behavior, historical behavior, migration from older designs, or backward compatibility.

## Documentation visual rules

- Never use a decorative vertical border or accent rail on callouts.
- Render icon references as graphical symbols. Never expose an icon component name such as `Network` or `Terminal` as visible text.
- Never put code snippets inside horizontal or vertical scroll regions. Wrap long lines and use an inline expand or collapse control for long blocks.

## Compatibility policy

This project has no production users or production data. Do not preserve legacy APIs, formats, schemas, behavior, or implementation patterns unless the user explicitly changes this policy.

Prefer the simplest correct current design. Breaking changes are acceptable, and compatibility layers, deprecation paths, fallback behavior, and legacy migrations are unnecessary unless explicitly requested.
