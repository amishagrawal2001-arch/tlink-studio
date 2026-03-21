import * as path from 'path'
import * as fs from 'fs'
import * as semver from 'semver'
import * as childProcess from 'child_process'

process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : (process.env.ARCH || process.arch)

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const electronInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/electron/package.json')))
const appPackage = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'app/package.json')))

function existingPaths (entries) {
    return entries.filter(entry => fs.existsSync(path.resolve(repoRoot, entry)))
}

function resolveVersionSource () {
    if (process.env.TLINK_VERSION?.trim()) {
        return process.env.TLINK_VERSION.trim()
    }
    try {
        return childProcess.execSync('git describe --tags', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
        const pkgVersion = appPackage.version || '0.0.0'
        return pkgVersion.startsWith('v') ? pkgVersion : `v${pkgVersion}`
    }
}

export let version = resolveVersionSource()
if (version.startsWith('v')) {
    version = version.substring(1)
}
version = version.replace('-', '-c')

if (version.includes('-c')) {
    const bumped = semver.inc(version, 'prepatch')
    if (bumped) {
        version = bumped.replace('-0', `-nightly.${process.env.REV ?? 0}`)
    } else {
        // Fallback for non-standard git describe output
        version = `${version}-nightly.${process.env.REV ?? 0}`
    }
}

const studioBuiltinPlugins = [
    'tlink-core',
    'tlink-studio-shell',
    'tlink-settings',
    'tlink-terminal',
    'tlink-local',
]

const fullBuiltinPlugins = [
    'tlink-core',
    'tlink-studio-shell',
    'tlink-settings',
    'tlink-terminal',
    'tlink-web',
    'builtin-plugins/tabby-vscode-agent',
    'tlink-community-color-schemes',
    'tlink-ssh',
    'tlink-serial',
    'tlink-telnet',
    'tlink-local',
    'tlink-rdp',
    'tlink-electron',
    'tlink-plugin-manager',
    'tlink-linkifier',
    'tlink-auto-sudo-password',
    'tlink-intellij-bridge',
    'tlink-chatgpt',
    'tlink-ai-assistant',
]

const studioMinimalPluginsEnabled = (process.env.TLINK_STUDIO_MINIMAL_PLUGINS ?? process.env.TLINK_STUDIO_APP ?? '1') === '1'

export const builtinPlugins = existingPaths(studioMinimalPluginsEnabled ? studioBuiltinPlugins : fullBuiltinPlugins)

export const packagesWithDocs = [
    ['.', 'tlink-core'],
    ['terminal', 'tlink-terminal'],
    ['local', 'tlink-local'],
    ['settings', 'tlink-settings'],
]

export const allPackages = [
    ...builtinPlugins,
    ...existingPaths(studioMinimalPluginsEnabled ? [] : ['web', 'tlink-web-demo']),
]

export const bundledModules = [
    '@angular',
    '@ng-bootstrap',
]
export const electronVersion = electronInfo.version

export const keygenConfig = {
    provider: 'keygen',
    account: 'a06315f2-1031-47c6-9181-e92a20ec815e',
    channel: 'stable',
    product: {
        win32: {
            x64: 'f481b9d6-d5da-4970-b926-f515373e986f',
            arm64: '950999b9-371c-419b-b291-938c5e4d364c',
        }[process.env.ARCH],
        darwin: {
            arm64: '98fbadee-c707-4cd6-9d99-56683595a846',
            x86_64: 'f5a48841-d5b8-4b7b-aaa7-cf5bffd36461',
            x64: 'f5a48841-d5b8-4b7b-aaa7-cf5bffd36461',
        }[process.env.ARCH],
        linux: {
            x64: '7bf45071-3031-4a26-9f2e-72604308313e',
            arm64: '39e3c736-d4d4-4fbf-a201-324b7bab0d17',
            armv7l: '50ae0a82-7f47-4fa4-b0a8-b0d575ce9409',
            armhf: '7df5aa12-04ab-4075-a0fe-93b0bbea9643',
        }[process.env.ARCH],
    }[process.platform],
}

if (!keygenConfig.product) {
    throw new Error(`Unrecognized platform ${process.platform}/${process.env.ARCH}`)
}
