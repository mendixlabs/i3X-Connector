import * as esbuild from 'esbuild'
import {copyToAppPlugin, copyManifestPlugin, copySkillsToAppPlugin, commonConfig} from "./build.helpers.mjs"
import parseArgs from "minimist"
import fs from "node:fs/promises"

const outDir = `dist/i3X-Connector`
const appDir = "C:\\Users\\mxwsah\\Mendix\\i3x-Connector-main"
const extensionDirectoryName = "extensions"
// The Maia skill in skills/ is parked: add-on module exports do not include skills yet, so the
// tools must work without it. To deploy it again, add this plugin to the list below:
// copySkillsToAppPlugin(appDir, skillsDir, moduleSkillsDirName)
const skillsDir = "skills"
// The skills folder Studio Pro created for the i3X_Connector module, which the extension ships in
const moduleSkillsDirName = "i3x_connector"

const entryPoints = [
    {
        in: 'src/main/index.ts',
        out: 'main'
    }
]

entryPoints.push({
    in: 'src/ui/index.tsx',
    out: 'list'
})

const args = parseArgs(process.argv.slice(2))
// esbuild never removes chunks from earlier builds, and stale ones end up in the module package
await fs.rm(outDir, { recursive: true, force: true })
const buildContext = await esbuild.context({
  ...commonConfig,
  outdir: outDir,
  plugins: [copyManifestPlugin(outDir), copyToAppPlugin(appDir, outDir, extensionDirectoryName)],
  entryPoints
})

if('watch' in args) {
    await buildContext.watch();
}
else {
    await buildContext.rebuild();
    await buildContext.dispose();
}
