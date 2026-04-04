#!/usr/bin/env node
import * as vars from './vars.mjs'
import log from 'npmlog'
import webpack from 'webpack'
import { promisify } from 'node:util'
import os from 'node:os'

const appConfigs = [
    '../app/webpack.config.main.mjs',
    '../app/webpack.config.mjs',
]

const pluginConfigs = vars.allPackages.map(x => `../${x}/webpack.config.mjs`)

const defaultConfigs = [...appConfigs, ...pluginConfigs]

const requestedConfigs = (process.env.TLINK_BUILD_CONFIGS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

const configs = requestedConfigs.length ? requestedConfigs : defaultConfigs

const statsOptions = { colors: true }
if (process.env.CI) {
    statsOptions.warnings = false
}

async function buildOne (c) {
    log.info('build', c)
    const imported = await import(c)
    const configFactory = imported.default ?? imported
    const config = typeof configFactory === 'function' ? configFactory() : configFactory
    const stats = await promisify(webpack)(config)
    console.log(stats.toString(statsOptions))
    if (stats.hasErrors()) {
        throw new Error(`Build failed: ${c}`)
    }
}

async function buildParallel (configPaths, concurrency) {
    const queue = [...configPaths]
    const errors = []
    async function worker () {
        while (queue.length) {
            const c = queue.shift()
            try {
                await buildOne(c)
            } catch (err) {
                errors.push(err)
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, configPaths.length) }, () => worker())
    await Promise.all(workers)
    if (errors.length) {
        for (const err of errors) {
            console.error(err.message)
        }
        process.exit(1)
    }
}

;(async () => {
    // Build app configs sequentially (shared output directory)
    const appToBuild = configs.filter(c => appConfigs.includes(c))
    const pluginsToBuild = configs.filter(c => !appConfigs.includes(c))

    for (const c of appToBuild) {
        await buildOne(c)
    }

    // Build plugin configs in parallel
    if (pluginsToBuild.length) {
        const concurrency = Math.max(1, Math.min(os.cpus().length, 4))
        log.info('build', `Building ${pluginsToBuild.length} plugins (concurrency: ${concurrency})`)
        await buildParallel(pluginsToBuild, concurrency)
    }
})()
