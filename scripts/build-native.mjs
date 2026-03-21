#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import * as path from 'path'
import * as fs from 'fs'
import * as vars from './vars.mjs'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))


if (process.platform === 'win32' || process.platform === 'linux') {
    process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : process.env.ARCH || process.arch
} else {
    process.env.ARCH ??= process.arch
}

const rebuildTargets = ['app', 'tlink-core', 'tlink-local', 'tlink-ssh', 'tlink-terminal']
const builds = []

for (const dir of rebuildTargets) {
    const buildPath = path.resolve(__dirname, '../' + dir)
    if (!fs.existsSync(buildPath)) {
        console.info('Skipping missing package', dir)
        continue
    }

    const build = rebuild({
        buildPath,
        electronVersion: vars.electronVersion,
        arch: process.env.ARCH,
        force: true,
    })
    builds.push({ build, dir })
}

console.info('Building against Electron', vars.electronVersion)

for (const { build, dir } of builds) {
    const lc = build.lifecycle
    lc.on('module-found', name => {
        console.info('Rebuilding', dir + '/' + name)
    })
}

try {
    await Promise.all(builds.map(x => x.build))
} catch (e) {
    console.error(e)
    process.exit(1)
}
