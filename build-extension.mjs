import * as esbuild from 'esbuild'
import {copyToAppPlugin, copyManifestPlugin, copySkillsToAppPlugin, commonConfig} from "./build.helpers.mjs"
import parseArgs from "minimist"

const outDir = `dist/i3X-Connector`
const appDir = "C:\\Users\\mxwsah\\Mendix\\i3x-Connector-main"
const extensionDirectoryName = "extensions"
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
const buildContext = await esbuild.context({
  ...commonConfig,
  outdir: outDir,
  plugins: [copyManifestPlugin(outDir), copyToAppPlugin(appDir, outDir, extensionDirectoryName), copySkillsToAppPlugin(appDir, skillsDir, moduleSkillsDirName)],
  entryPoints
})

if('watch' in args) {
    await buildContext.watch();
}
else {
    await buildContext.rebuild();
    await buildContext.dispose();
}
