---
name: mulesoft
description: Work on MuleSoft 4 (Anypoint) projects: flow XML layout, validating Mule XML with pi-lens LSP diagnostics, connector schema catalog. Use when a directory has mule-artifact.json or editing src/main/mule/*.xml.
---

# MuleSoft 4 projects

## Layout
- `mule-artifact.json` — marks a Mule project root.
- `pom.xml` — Maven build and connector dependencies.
- `src/main/mule/*.xml` — flows, sub-flows, global configs.
- `src/main/resources` — properties files and `*.dwl` DataWeave modules.
- `src/test/munit` — MUnit test suites.

## Validating Mule XML
After editing a Mule XML file, call `lens_diagnostics` with `source=lsp`, `scope=paths` and the path of the file you
just edited. An empty cached result does not mean the file is clean; ask for the path explicitly.

## Reading errors
- `cvc-complex-type.2.4.a` on a connector element usually means the connector is missing from the local schema
  catalog, not that your XML is wrong. Fix: open the project in Anypoint Studio once, then run `/mule-lsp catalog`.
  Do not "fix" valid XML only to silence this error.
- Never rewrite `xsi:schemaLocation` to local URLs; the catalog maps the official `http://www.mulesoft.org/...` URLs.

## Not covered
**DataWeave is not checked by the LSP.** Review `.dwl` files and `ee:transform` scripts by hand or run MUnit.

## No diagnostics at all?
Run `/mule-lsp doctor`. Typical causes: project not trusted (`/trust`), server not registered
(`/mule-lsp init`), pi-lens not loaded (`/lens-health`).
