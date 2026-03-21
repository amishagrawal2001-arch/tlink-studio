#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'
import { execSync } from 'child_process'
import { getArtifactSuffix, getExtraResources, isOllamaBundleEnabled } from './bundle-ollama.mjs'
import { ensureBuiltinPlugins } from './ensure-builtin-plugins.mjs'

const isTag = (process.env.GITHUB_REF || process.env.BUILD_SOURCEBRANCH || '').startsWith('refs/tags/')
const keypair = process.env.SM_KEYPAIR_ALIAS

process.env.ARCH = process.env.ARCH || process.arch

console.log('Signing enabled:', !!keypair)

function normalizeWinArch (arch) {
    if (arch === 'x86_64' || arch === 'x64') {
        return 'x64'
    }
    if (arch === 'aarch64' || arch === 'arm64') {
        return 'arm64'
    }
    return arch
}

const targetArch = normalizeWinArch(process.env.ARCH)
const windowsElectronDist = process.env.TLINK_WINDOWS_ELECTRON_DIST
if (windowsElectronDist) {
    console.log('Using Windows Electron dist override:', windowsElectronDist)
}

ensureBuiltinPlugins()

const bundleOllama = isOllamaBundleEnabled()
const artifactSuffix = getArtifactSuffix(bundleOllama)
const extraResources = getExtraResources(bundleOllama)

const requestedWindowsArtifacts = (process.env.TLINK_WINDOWS_ARTIFACTS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

const windowsTargets = requestedWindowsArtifacts.length ? requestedWindowsArtifacts : ['nsis', 'zip']

builder({
    dir: true,
    win: windowsTargets,
    x64: targetArch === 'x64',
    arm64: targetArch === 'arm64',
    config: {
        ...(windowsElectronDist ? { electronDist: windowsElectronDist } : {}),
        extraMetadata: {
            version: vars.version,
        },
        ...(extraResources ? { extraResources } : {}),
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
        forceCodeSigning: !!keypair,
        win: {
            artifactName: `tlink-studio-\${version}-portable-\${arch}${artifactSuffix}.\${ext}`,
            signtoolOptions: {
                certificateSha1: process.env.SM_CODE_SIGNING_CERT_SHA1_HASH,
                publisherName: process.env.SM_PUBLISHER_NAME,
                signingHashAlgorithms: ['sha256'],
                sign: keypair ? async function (configuration) {
                    console.log('Signing', configuration)
                    if (configuration.path) {
                        try {
                            const cmd = `smctl sign --keypair-alias=${keypair} --input "${String(configuration.path)}"`
                            console.log(cmd)
                            const out = execSync(cmd)
                            if (out.toString().includes('FAILED')) {
                                throw new Error(out.toString())
                            }
                            console.log(out.toString())
                        } catch (e) {
                            console.error(`Failed to sign ${configuration.path}`)
                            if (e.stdout) {
                                console.error('stdout:', e.stdout.toString())
                            }
                            if (e.stderr) {
                                console.error('stderr:', e.stderr.toString())
                            }
                            console.error(e)
                            process.exit(1)
                        }
                    }
                } : undefined,
            },
        },
        nsis: {
            artifactName: `tlink-studio-\${version}-setup-\${arch}${artifactSuffix}.\${ext}`,
        },
    },

    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
