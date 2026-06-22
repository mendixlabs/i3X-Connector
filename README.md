# i3X Connector for Mendix Studio Pro

A Mendix Studio Pro extension that connects your Mendix app to the [CESMII i3X Smart Manufacturing Platform](https://i3x.cesmii.net/). It browses i3X object types and generates the corresponding Mendix domain model artifacts — entities, attributes, associations, JSON structures, import mappings, and microflows — directly inside Studio Pro.

> **This is a proof of concept.** It is not an official product of, endorsed by, or affiliated with CESMII.

## Quick install

The extension is available on the [Mendix Marketplace](https://marketplace.mendix.com/link/component/201816). For Mendix Studio Pro 11.10+, download it from the Marketplace and follow the in-product import flow.

Alternatively, you can install the prebuilt module package directly from [Packages/i3X_Connector.mxmodule](Packages/i3X_Connector.mxmodule): in App Explorer, right-click the **App** node, choose **Import Module Package**, then select the file.

## How to use

Once the extension is installed, open it from the Studio Pro top menu: **Extensions → i3X Connector**. This opens the connector panel where you configure the connection and generate artifacts.

## What it does

1. You enter your i3X API base URL and auth credentials in the extension panel.
2. The extension fetches the available object types from the i3X API.
3. You pick an object type and the extension generates:
   - Mendix entities (one per object type, plus nested group entities)
   - Attributes mapped from the JSON schema properties
   - Associations between base and group entities
   - A JSON structure and import mapping for deserializing API responses
   - A microflow that calls the i3X API and imports the result
   - An objects list microflow for querying `/objects?typeElementId=...`
4. Optionally, a separate "write values" microflow can be generated for pushing values back to i3X.

## Requirements

- Mendix Studio Pro 11.10 or later
- An i3X API endpoint (self-hosted or CESMII-hosted) with valid credentials

## Installation

There are three ways to install the extension.

**Option A — install from the Mendix Marketplace.** Download the [i3X Connector](https://marketplace.mendix.com/link/component/201816) from the Marketplace and follow the in-product import flow.

**Option B — import the prebuilt module package.** In App Explorer, right-click the **App** node, choose **Import Module Package**, and select [Packages/i3X_Connector.mxmodule](Packages/i3X_Connector.mxmodule).

**Option C — build from source** (see [Development](#development) below), then copy the `dist/i3X-Connector/` folder into your Mendix app's `extensions/` directory.

## Development

The extension is a standard Mendix Studio Pro extension. The [Mendix documentation on building extensions](https://docs.mendix.com/apidocs-mxsdk/apidocs/extensibility-api/) explains the overall setup, project structure, and how to load an extension in Studio Pro during development.

### Prerequisites

- Node.js 18+
- A local Mendix Studio Pro app to test against

### Setup

1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Open `build-extension.mjs` and update the `appDir` variable to point to your local Mendix app's root directory. The build script will copy the built extension there automatically.
4. Build:
   ```bash
   npm run build
   ```
   Or watch for changes during development:
   ```bash
   npm run build:dev
   ```

The build runs TypeScript type-checking first, then bundles via esbuild into `dist/i3X-Connector/`. If `appDir` exists, the output is also copied there so Studio Pro picks it up on the next restart.

### Project layout

```
src/
  main/index.ts       — registers the menu item in Studio Pro (main process)
  ui/index.tsx        — React app entry point (UI process)
  ui/components/      — Loader, List, DetailPanel
  ui/services/        — auth, URL normalization, Studio Pro code generation
  ui/types/           — shared TypeScript types
  manifest.json       — extension manifest
```

## Auth support

The extension supports three auth modes for the i3X API:

- **None** — unauthenticated requests
- **Basic** — username and password (sent as a Base64-encoded `Authorization` header)
- **Token** — a custom header with an optional prefix (e.g. `Bearer`)
