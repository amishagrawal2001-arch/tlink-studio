#!/usr/bin/env node
import sh from 'shelljs'
import * as vars from './vars.mjs'
import log from 'npmlog'
import * as path from 'path'

const repoRoot = process.cwd()
const cdRepo = () => {
    sh.cd(repoRoot)
}

log.info('patch')
sh.exec(`yarn patch-package`, { fatal: true })

log.info('deps', 'app')

sh.cd(path.join(repoRoot, 'app'))
sh.exec(`yarn install --force --network-timeout 1000000 --ignore-scripts`, { fatal: true })
if (process.env.TLINK_SKIP_APP_POSTINSTALL === '1') {
    log.info('deps', 'app postinstall skipped')
} else {
    // Some native packages might fail to build before patch-package gets a chance to run via postinstall
    sh.exec(`yarn postinstall`, { fatal: false })
}
cdRepo()

sh.cd(path.join(repoRoot, 'web'))
sh.exec(`yarn install --force --network-timeout 1000000`, { fatal: true })
sh.exec(`yarn patch-package`, { fatal: true })
cdRepo()

vars.allPackages.forEach(plugin => {
    log.info('deps', plugin)
    const pluginPath = path.join(repoRoot, plugin)
    if (!sh.test('-d', pluginPath)) {
        log.warn('deps', `missing ${plugin}, skipping`)
        return
    }
    sh.cd(pluginPath)
    sh.exec(`yarn install --force --network-timeout 1000000`, { fatal: true })
    cdRepo()
})

if (['darwin', 'linux'].includes(process.platform)) {
    const nodeModulesPath = path.join(repoRoot, 'node_modules')
    sh.cd(nodeModulesPath)
    for (let x of vars.builtinPlugins) {
        const sourcePath = path.join(repoRoot, x)
        if (!sh.test('-e', sourcePath)) {
            log.warn('deps', `missing source ${x}, skipping link`)
            continue
        }
        const parentDir = path.dirname(x)
        if (parentDir && parentDir !== '.') {
            sh.mkdir('-p', parentDir)
        }
        const targetPath = path.join(nodeModulesPath, x)
        sh.rm('-f', targetPath)
        sh.ln('-s', sourcePath, targetPath)
    }
    cdRepo()
}
