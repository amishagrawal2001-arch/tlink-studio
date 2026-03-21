#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import { rebuild } from '@electron/rebuild'
import * as vars from './vars.mjs'
import { getArtifactSuffix, getExtraResources, isOllamaBundleEnabled } from './bundle-ollama.mjs'
import { ensureBuiltinPlugins } from './ensure-builtin-plugins.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const appPath = path.join(repoRoot, 'app')
const keytarBinaryPath = path.join(appPath, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node')
const ptyBinaryPath = path.join(appPath, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
const ptySpawnHelperPath = path.join(appPath, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')

function normalizeMacArch (arch) {
    if (arch === 'x86_64' || arch === 'x64') {
        return 'x86_64'
    }
    if (arch === 'aarch64' || arch === 'arm64') {
        return 'arm64'
    }
    return arch
}

function detectBinaryArchitectures (filePath) {
    try {
        const stdout = execFileSync('/usr/bin/lipo', ['-archs', filePath], { encoding: 'utf8' }).trim()
        if (stdout) {
            return new Set(stdout.split(/\s+/).filter(Boolean))
        }
    } catch {
        // fall through
    }

    try {
        const stdout = execFileSync('/usr/bin/file', [filePath], { encoding: 'utf8' })
        const arches = new Set()
        if (stdout.includes('x86_64')) {
            arches.add('x86_64')
        }
        if (stdout.includes('arm64')) {
            arches.add('arm64')
        }
        return arches
    } catch {
        return new Set()
    }
}

function keytarBinaryMatchesTargetArch (targetArch) {
    if (!fs.existsSync(keytarBinaryPath)) {
        return false
    }
    const expectedArch = normalizeMacArch(targetArch)
    const arches = detectBinaryArchitectures(keytarBinaryPath)
    if (!arches.size) {
        return true
    }
    return arches.has(expectedArch)
}

function ptyBinaryMatchesTargetArch (targetArch) {
    if (!fs.existsSync(ptyBinaryPath)) {
        return false
    }
    const expectedArch = normalizeMacArch(targetArch)
    const arches = detectBinaryArchitectures(ptyBinaryPath)
    if (!arches.size) {
        return true
    }
    return arches.has(expectedArch)
}

async function ensureKeytarBinary (targetArch) {
    if (keytarBinaryMatchesTargetArch(targetArch)) {
        return
    }

    console.log(`Ensuring keytar native module for arch=${targetArch}`)
    await rebuild({
        buildPath: appPath,
        electronVersion: vars.electronVersion,
        arch: targetArch,
        force: true,
        useCache: false,
        onlyModules: ['keytar'],
    })

    if (!fs.existsSync(keytarBinaryPath)) {
        throw new Error(`Missing keytar native module after rebuild: ${keytarBinaryPath}`)
    }
    if (!keytarBinaryMatchesTargetArch(targetArch)) {
        const detected = [...detectBinaryArchitectures(keytarBinaryPath)].join(', ') || 'unknown'
        throw new Error(`keytar native module arch mismatch: expected ${normalizeMacArch(targetArch)}, got ${detected}`)
    }
}

async function ensurePtyBinary (targetArch) {
    if (ptyBinaryMatchesTargetArch(targetArch) && fs.existsSync(ptySpawnHelperPath)) {
        return
    }

    console.log(`Ensuring node-pty native module for arch=${targetArch}`)
    await rebuild({
        buildPath: appPath,
        electronVersion: vars.electronVersion,
        arch: targetArch,
        force: true,
        useCache: false,
        onlyModules: ['node-pty'],
    })

    if (!fs.existsSync(ptyBinaryPath)) {
        throw new Error(`Missing node-pty native module after rebuild: ${ptyBinaryPath}`)
    }
    if (!fs.existsSync(ptySpawnHelperPath)) {
        throw new Error(`Missing node-pty spawn-helper after rebuild: ${ptySpawnHelperPath}`)
    }
    if (!ptyBinaryMatchesTargetArch(targetArch)) {
        const detected = [...detectBinaryArchitectures(ptyBinaryPath)].join(', ') || 'unknown'
        throw new Error(`node-pty native module arch mismatch: expected ${normalizeMacArch(targetArch)}, got ${detected}`)
    }
}

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = process.env.ARCH || process.arch

if (process.env.GITHUB_HEAD_REF) {
    delete process.env.CSC_LINK
    delete process.env.CSC_KEY_PASSWORD
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

process.env.APPLE_ID ??= process.env.APPSTORE_USERNAME
process.env.APPLE_APP_SPECIFIC_PASSWORD ??= process.env.APPSTORE_PASSWORD

ensureBuiltinPlugins()

const bundleOllama = isOllamaBundleEnabled()
const artifactSuffix = getArtifactSuffix(bundleOllama)
const extraResources = getExtraResources(bundleOllama)

const requestedMacArtifacts = (process.env.TLINK_MAC_ARTIFACTS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

const macTargets = requestedMacArtifacts.length ? requestedMacArtifacts : ['dmg', 'zip']

;(async () => {
    await ensureKeytarBinary(process.env.ARCH)
    await ensurePtyBinary(process.env.ARCH)

    await builder({
        dir: true,
        mac: macTargets,
        x64: process.env.ARCH === 'x86_64',
        arm64: process.env.ARCH === 'arm64',
        config: {
            extraMetadata: {
                version: vars.version,
                teamId: process.env.APPLE_TEAM_ID,
            },
            ...(extraResources ? { extraResources } : {}),
            mac: {
                identity: !process.env.CI || process.env.CSC_LINK ? undefined : null,
                notarize: !!process.env.APPLE_TEAM_ID,
                artifactName: `tlink-studio-\${version}-macos-\${arch}${artifactSuffix}.\${ext}`,
            },
            npmRebuild: process.env.ARCH !== 'arm64',
            publish: process.env.KEYGEN_TOKEN ? [
                vars.keygenConfig,
                {
                    provider: 'github',
                    channel: `latest-${process.env.ARCH}`,
                },
            ] : undefined,
        },
        publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
    })
})().catch(e => {
    console.error(e)
    process.exit(1)
})
