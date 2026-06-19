# Open Source Software Clearance

This document lists the third-party open source components distributed as part
of the i3X Connector extension package and records their license and clearance
status.

The extension itself is licensed under the MIT License (see [LICENSE.txt](LICENSE.txt)).

## Bundled runtime components

These components are bundled into the shipped extension (`dist/i3X-Connector/`
and `Packages/i3X_Connector.mxmodule`) by the esbuild bundle step.

| Component | Version | License | Cleared |
|---|---|---|---|
| react | 18.3.1 | MIT | Yes |
| react-dom | 18.3.1 | MIT | Yes |
| scheduler | 0.23.2 | MIT | Yes |
| js-tokens | 4.0.0 | MIT | Yes |
| loose-envify | 1.4.0 | MIT | Yes |

## Components provided by the Mendix runtime (not bundled)

`@mendix/extensions-api` is marked external in the build and is provided by
Mendix Studio Pro at runtime. It is not redistributed in this package and is
governed by the Mendix license terms shipped with Studio Pro.

| Component | Version | License |
|---|---|---|
| @mendix/extensions-api | 0.9.0-mendix.11.10.0 | Mendix license (see package `LICENSE.txt`) |

## Build-time only dependencies (not distributed)

TypeScript, esbuild, minimist, and the `@types/*` type definitions are
development dependencies used only to build the extension. They are not part of
the distributed package and therefore require no distribution clearance.

## License texts

All bundled components above are distributed under the MIT License. The full MIT
License text is reproduced in [LICENSE.txt](LICENSE.txt) and applies verbatim to
each MIT-licensed component, substituting the respective copyright holders:

- react, react-dom, scheduler: Copyright (c) Meta Platforms, Inc. and affiliates.
- js-tokens: Copyright (c) Simon Lydell.
- loose-envify: Copyright (c) Andres Suarez.
