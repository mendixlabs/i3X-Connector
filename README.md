# i3X Connector for Mendix Studio Pro

A Mendix Studio Pro extension that connects your Mendix app to the [CESMII i3X Smart Manufacturing Platform](https://i3x.cesmii.net/). It browses i3X object types and generates the corresponding Mendix domain model artifacts — entities, attributes, associations, JSON structures, import mappings, and microflows — directly inside Studio Pro.

> **This is a proof of concept.** It is not an official product of, endorsed by, or affiliated with CESMII.

## Quick install

The extension is available on the [Mendix Marketplace](https://marketplace.mendix.com/link/component/201816). Download it from the Marketplace and follow the in-product import flow.

Version 2.2.0 and later need Mendix Studio Pro 11.15 or later. On Studio Pro 11.10 to 11.14, use version 2.0.0.

Alternatively, you can install the prebuilt module package directly from [Packages/i3X_Connector.mxmodule](Packages/i3X_Connector.mxmodule): in App Explorer, right-click the **App** node, choose **Import Module Package**, then select the file.

## How to use

Once the extension is installed, open it from the Studio Pro top menu: **Extensions → i3X Connector**. This opens the connector panel where you configure the connection and generate artifacts.

## Using with Maia

From version 2.2.0 (Studio Pro 11.15 and later), the extension also registers tools that Maia can call. You can then ask Maia to browse the i3X server and generate artifacts without clicking through the panel.

| Tool | What it does |
|---|---|
| `i3x_connect` | Connects the other tools to the i3X server set in the app's constants |
| `i3x_list_object_types` | Lists the object types on the connected i3X server |
| `i3x_list_objects` | Lists the objects of one type |
| `i3x_generate_artifacts` | Generates value query, history, write or subscription artifacts for one type in `i3X_Implementation` |

To set it up:

1. Open **View > Extensions** and grant the **Register AI Tools** permission to the i3X Connector.
2. Connect to a server in one of two ways:
   - **Through Maia:** `i3x_connect` reads the server URL and credentials from the String constants in `i3X_Implementation`: `API_BaseUrl`, plus `API_Token` or `API_Username` and `API_Password`. The connector creates these constants the first time it generates artifacts. If they don't exist yet, Maia can create them for you. Any URL or credential you type in the chat stays in the chat history.
   - **In the tab:** open **Extensions > i3X Connector**, enter the server URL and credentials, and press **Load**.

   Both ways share one connection. A connection made through Maia also shows up in the tab. It lasts for the current Studio Pro session.
3. Ask Maia. For example: "Which pumps are on the i3X server?" or "Build me a microflow that reads the current pump values from the i3X server".

Mention the i3X server in your question. The app also contains modules with i3x in their names, and Maia may search those instead. If it does, name the tool, for example "Call `i3x_list_objects` for Pump". Maia asks for confirmation before every tool call.

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

- Mendix Studio Pro 11.15 or later (built against `@mendix/extensions-api` 0.14.0)
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
  main/index.ts:           registers the menu item and the Maia tools (main process)
  main/i3xTools.ts:        Maia tool definitions (connect, list object types, list objects, generate artifacts)
  main/aiTools.ts:         Maia tool registration, gated on the register-ai-tools permission
  main/i3xConnect.ts:      reads the i3x_connect tool's connection from the app's constants
  main/connectionStore.ts: holds the connection the UI tab shares with the Maia tools
  shared/messages.ts:      message types passed between the UI tab and main
  ui/index.tsx:            React app entry point (UI process)
  ui/components/:          Loader, List, DetailPanel
  ui/services/:            auth, URL normalization, Studio Pro code generation
  ui/types/:               shared TypeScript types
  manifest.json:           extension manifest
```

## Auth support

The extension supports three auth modes for the i3X API:

- **None** — unauthenticated requests
- **Basic** — username and password (sent as a Base64-encoded `Authorization` header)
- **Token** — a custom header with an optional prefix (e.g. `Bearer`)
