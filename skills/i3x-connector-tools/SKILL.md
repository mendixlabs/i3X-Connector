---
name: i3x-connector-tools
description: Use when the user wants to browse a CESMII i3X smart manufacturing server (object types, equipment, objects, live or historical values) or generate Mendix entities, mappings and microflows that read from, write to or subscribe to an i3X server. Covers the i3x_list_object_types, i3x_list_objects and i3x_generate_artifacts tools from the i3X Connector extension.
---

# i3X Connector tools

The i3X Connector extension gives you three tools that talk to a **remote CESMII i3X server** over HTTP:

| Tool | Use it to |
|---|---|
| `i3x_list_object_types` | See which object types (equipment and data models, such as a pump or a motor drive) the server offers |
| `i3x_list_objects` | See the object instances of one type, such as the individual pumps |
| `i3x_generate_artifacts` | Generate Mendix artifacts for one type in the `i3X_Implementation` module |

## Server versus app model

The app also contains Mendix modules named `i3x_connector` and `i3x_implementation`. When the user asks about i3X types, objects, equipment or server data, they mean the **remote server**. Call the tools. Don't search or read the app model for that.

Search the app model only when the user asks about artifacts that already exist in the app, for example "open the value query microflow for Pump". The artifact names follow fixed patterns, listed in [artifact names](references/artifact-names.md).

## Rules

1. **Always call the tool for server data.** Object types and objects change on the server. Call the tool again for each question, even if an earlier answer in this chat looks the same. Never answer from memory, and never invent type names, object names or elementIds.
2. **Pass names as the user said them.** `objectType` accepts a display name ("Pump"), an elementId, or a partial name that matches exactly one type. You don't need to call `i3x_list_object_types` first just to find an id.
3. **If a tool says "matches several object types", ask the user which one.** Don't pick one yourself.
4. **If a tool says "Not connected", stop.** Tell the user to open **Extensions > i3X Connector**, enter the server URL and credentials, and press **Load**. Then retry. Never ask the user for credentials in the chat.
5. **Every tool call asks the user for confirmation.** That's expected. Don't call a tool again only to work around a declined confirmation.

## Generating artifacts

Artifact kinds for `i3x_generate_artifacts`:

| Kind | Generates | Needs |
|---|---|---|
| `valueQuery` | Entities for the type, a JSON structure, an import mapping and a microflow that reads current values | Nothing |
| `history` | A microflow, JSON structure and import mapping that read historical values | Nothing |
| `write` | A microflow and export mapping that write values back | `valueQuery` entities |
| `subscription` | Entities and microflows that subscribe to value changes | `valueQuery` entities |

- When the user asks for `write` or `subscription` and the value query was never generated, include `valueQuery` in the same call.
- The tool reuses existing artifacts and never duplicates them. You can safely call it again for a type.
- `elementId` is optional. It picks which object serves as the live sample for `valueQuery`. Without it, the tool uses the type's first object.

After a generation, check the result for these cases and tell the user:

- **"built from the type schema"**: no live object was available. Property types may not match what the server returns.
- **"Action needed ... PUT"**: a new write microflow needs its REST call method changed to PUT before use. Offer to open the microflow.
- **"skipped"**: write or subscription didn't run because the value query entities are missing.

## Example requests

- "What equipment types are on the i3X server?" → `i3x_list_object_types`
- "Which pumps are there?" → `i3x_list_objects` with `objectType: "Pump"`
- "Build me a microflow that reads the current pump values" → `i3x_generate_artifacts` with `objectType: "Pump"` and `artifacts: ["valueQuery"]`
- "I also want to write pump values back" → `i3x_generate_artifacts` with `artifacts: ["valueQuery", "write"]`
